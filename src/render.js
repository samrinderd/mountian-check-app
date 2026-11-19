// Draws the AR overlay on a 2D canvas: skyline trace, peak labels and the
// compass strip. Everything is on one canvas so a photo capture can reuse it.

import { angleDiff, cardinal, makeCamera, R2D, wrap360 } from './geo.js';
import { horizonAt } from './visibility.js';

export const COLORS = {
  plate: 'rgba(13, 20, 27, 0.8)',
  plateEdge: 'rgba(255, 255, 255, 0.16)',
  text: '#ffffff',
  sub: '#c5d1da',
  accent: '#ffb224',
  shadow: 'rgba(0, 0, 0, 0.55)',
};
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const NAME_FONT = `600 15px ${FONT}`;
const SUB_FONT = `500 12px ${FONT}`;

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatHeight(m, units) {
  return units === 'imperial' ? `${nf0.format(m * 3.28084)} ft` : `${nf0.format(m)} m`;
}
export function formatDistance(m, units) {
  const v = units === 'imperial' ? m / 1609.344 : m / 1000;
  return `${v < 100 ? nf1.format(v) : nf0.format(v)} ${units === 'imperial' ? 'mi' : 'km'}`;
}
export function peakSubtitle(a, units) {
  const approx = Number.isFinite(a.peak.ele) ? '' : '~';
  return `${approx}${formatHeight(a.height, units)} · ${formatDistance(a.dist, units)}`;
}

const widths = new Map();
function textWidth(ctx, font, text) {
  const key = font + text;
  let w = widths.get(key);
  if (w === undefined) {
    ctx.font = font;
    w = ctx.measureText(text).width;
    if (widths.size > 4000) widths.clear();
    widths.set(key, w);
  }
  return w;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * view:  { heading, pitch, roll, f }            camera pose, f in CSS pixels
 * scene: { visible, horizon, units }            assessed peaks sorted by score
 * opts:  { backdrop, skyline, top, plates, glassSource }
 * Returns { hits, labels, readout }: tap targets, label boxes for the page
 * to place glass plates on, and the heading text.
 */
export function drawScene(ctx, w, h, view, scene, opts = {}) {
  const project = makeCamera({ ...view, cx: w / 2, cy: h / 2 });
  const halfSpan = Math.min(89, Math.atan(Math.hypot(w, h) / 2 / view.f) * R2D + 2);
  const top = opts.top ?? 0;
  const hits = [];

  if (opts.backdrop) drawSky(ctx, w, h, project, view);

  // Skyline, computed from terrain. Filled in when there is no camera image.
  if (scene.horizon && (opts.backdrop || opts.skyline)) {
    const pts = [];
    for (let d = -halfSpan; d <= halfSpan; d += 0.25) {
      const az = view.heading + d;
      const p = project(az, horizonAt(scene.horizon, az));
      if (p) pts.push(p);
    }
    if (pts.length > 1) {
      if (opts.backdrop) {
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, '#3d5166');
        g.addColorStop(1, '#17212b');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, h + 50);
        for (const p of pts) ctx.lineTo(p.x, p.y);
        ctx.lineTo(pts[pts.length - 1].x, h + 50);
        ctx.closePath();
        ctx.fill();
      }
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (opts.skyline) {
        ctx.strokeStyle = COLORS.shadow;
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.strokeStyle = COLORS.accent;
        ctx.lineWidth = 1.5;
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
      }
      ctx.stroke();
    }
  }

  // Peaks: best-scoring first, each label takes the lowest free slot above
  // its summit. Peaks that cannot fit a label still get a small marker.
  const placed = [];
  const maxLabels = Math.max(6, Math.min(16, Math.round(w / 45)));
  const boxH = 42, gap = 5, minY = top + 58;
  let dots = 0;
  const labels = [];
  for (const a of scene.visible ?? []) {
    if (Math.abs(angleDiff(a.bearing, view.heading)) > halfSpan) continue;
    const p = project(a.bearing, a.el);
    if (!p || p.x < -20 || p.x > w + 20 || p.y < minY || p.y > h + 20) continue;
    let box = null;
    if (labels.length < maxLabels) {
      const sub = peakSubtitle(a, scene.units);
      const bw = Math.ceil(Math.max(textWidth(ctx, NAME_FONT, a.peak.name), textWidth(ctx, SUB_FONT, sub))) + 28;
      const bx = Math.max(6, Math.min(w - bw - 6, p.x - bw / 2));
      if (p.x > 6 + 10 && p.x < w - 16) {
        for (let k = 0; k < 5 && !box; k++) {
          const by = p.y - 22 - boxH - k * (boxH + gap);
          if (by < minY - 44) break;
          const clash = placed.some((o) => bx < o.x + o.w + gap && bx + bw + gap > o.x && by < o.y + o.h + gap && by + boxH + gap > o.y);
          if (!clash) box = { x: bx, y: by, w: bw, h: boxH, a, p, sub };
        }
      }
    }
    if (box) {
      placed.push(box);
      labels.push(box);
    } else if (dots < 40) {
      dots++;
      drawMarker(ctx, p.x, p.y, 3.5, 'rgba(255,255,255,0.75)');
      hits.push({ x: p.x - 16, y: p.y - 16, w: 32, h: 32, item: a });
    }
  }
  // Leader lines under plates, so a line never crosses another label's text.
  for (const b of labels) {
    ctx.beginPath();
    ctx.moveTo(b.p.x, b.p.y - 7);
    ctx.lineTo(b.p.x, b.y + b.h);
    ctx.strokeStyle = COLORS.shadow;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  for (const b of labels) {
    drawMarker(ctx, b.p.x, b.p.y, 5, COLORS.accent);
    hits.push({ x: b.x, y: b.y, w: b.w, h: b.h + 24, item: b.a });
    // Live, the plates are real glass elements placed by the page; in a photo
    // they are painted here.
    if (opts.plates === false) continue;
    glassPlate(ctx, b.x, b.y, b.w, b.h, PLATE_RADIUS, opts.glassSource);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.font = NAME_FONT;
    ctx.fillStyle = COLORS.text;
    ctx.fillText(b.a.peak.name, b.x + 13, b.y + 18);
    ctx.font = SUB_FONT;
    ctx.fillStyle = COLORS.sub;
    ctx.fillText(b.sub, b.x + 13, b.y + 34);
  }

  const readout = drawCompass(ctx, w, top, view, opts.plates !== false, opts.glassSource);
  return {
    hits,
    readout,
    labels: labels.map((b) => ({ id: b.a.peak.id, x: b.x, y: b.y, w: b.w, h: b.h, name: b.a.peak.name, sub: b.sub })),
  };
}

export const PLATE_RADIUS = 15;
let canFilter;

/**
 * Paints a frosted-glass plate: a blurred copy of whatever is behind it (when
 * the browser can filter canvas drawing), a dark tint, a soft top highlight
 * and a bright rim.
 */
function glassPlate(ctx, x, y, w, h, r, source) {
  canFilter ??= typeof ctx.filter === 'string';
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 4;
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = canFilter && source ? 'rgba(18,24,32,0.5)' : 'rgba(18,24,32,0.62)';
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  if (canFilter && source) {
    const k = ctx.getTransform().a; // source is this canvas, in device pixels
    const pad = 24;
    ctx.filter = 'blur(12px) saturate(170%)';
    ctx.drawImage(source, (x - pad) * k, (y - pad) * k, (w + pad * 2) * k, (h + pad * 2) * k, x - pad, y - pad, w + pad * 2, h + pad * 2);
    ctx.filter = 'none';
    ctx.fillStyle = 'rgba(18,24,32,0.36)';
    ctx.fillRect(x, y, w, h);
  }
  const sheen = ctx.createLinearGradient(0, y, 0, y + h);
  sheen.addColorStop(0, 'rgba(255,255,255,0.22)');
  sheen.addColorStop(0.45, 'rgba(255,255,255,0.04)');
  sheen.addColorStop(1, 'rgba(255,255,255,0.08)');
  ctx.fillStyle = sheen;
  ctx.fillRect(x, y, w, h);
  ctx.restore();

  const rim = ctx.createLinearGradient(0, y, 0, y + h);
  rim.addColorStop(0, 'rgba(255,255,255,0.6)');
  rim.addColorStop(0.5, 'rgba(255,255,255,0.14)');
  rim.addColorStop(1, 'rgba(255,255,255,0.3)');
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r);
  ctx.strokeStyle = rim;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawMarker(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y + r * 0.8);
  ctx.lineTo(x - r, y + r * 0.8);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = COLORS.shadow;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fill();
}

function drawSky(ctx, w, h, project, view) {
  const horizon = project(view.heading, 0)?.y ?? h / 2;
  const g = ctx.createLinearGradient(0, Math.min(0, horizon - h), 0, Math.max(h * 0.4, horizon));
  g.addColorStop(0, '#27496b');
  g.addColorStop(1, '#c4d3dc');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function drawCompass(ctx, w, top, view, paintReadout, glassSource) {
  const bandH = 38;
  const g = ctx.createLinearGradient(0, 0, 0, top + bandH + 14);
  g.addColorStop(0, 'rgba(8,13,18,0.5)');
  g.addColorStop(1, 'rgba(8,13,18,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, top + bandH + 14);

  const span = Math.min(80, Math.atan(w / 2 / view.f) * R2D);
  const first = Math.ceil((view.heading - span) / 5) * 5;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 4;
  for (let d = first; d <= view.heading + span; d += 5) {
    const x = w / 2 + view.f * Math.tan(((d - view.heading) * Math.PI) / 180);
    const deg = wrap360(d);
    const major = deg % 45 === 0, mid = deg % 15 === 0;
    ctx.fillStyle = major ? '#fff' : 'rgba(255,255,255,0.6)';
    ctx.fillRect(x - 0.5, top + 6, major ? 1.5 : 1, major ? 9 : mid ? 7 : 4);
    if (major || mid) {
      ctx.font = major ? `700 13px ${FONT}` : `500 10px ${FONT}`;
      ctx.fillStyle = deg === 0 ? COLORS.accent : major ? '#fff' : 'rgba(255,255,255,0.7)';
      ctx.fillText(major ? cardinal(deg) : String(deg), x, top + 30);
    }
  }
  ctx.restore();
  // Centre pointer and readout.
  ctx.fillStyle = COLORS.accent;
  ctx.beginPath();
  ctx.moveTo(w / 2, top + 7);
  ctx.lineTo(w / 2 - 5, top);
  ctx.lineTo(w / 2 + 5, top);
  ctx.closePath();
  ctx.fill();
  const label = `${Math.round(wrap360(view.heading)) % 360}° ${cardinal(view.heading)}`;
  if (paintReadout) {
    ctx.font = `600 13px ${FONT}`;
    const lw = ctx.measureText(label).width + 24;
    glassPlate(ctx, w / 2 - lw / 2, top + 36, lw, 26, 13, glassSource);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, w / 2, top + 53.5);
  }
  return label;
}
