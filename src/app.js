import { cardinal, focalLength, haversine, R2D, wrap360 } from './geo.js';
import { loadTerrain } from './dem.js';
import { loadPeaks } from './peaks.js';
import { assessPeak, computeHorizon, observerHeight, peakScore, rayDistances } from './visibility.js';
import { keepAwake, Orientation, startCamera, watchLocation } from './sensors.js';
import { drawScene, formatDistance, formatHeight } from './render.js';

const $ = (id) => document.getElementById(id);
const video = $('cam'), canvas = $('ar'), ctx = canvas.getContext('2d');

// --- Settings ------------------------------------------------------------------

const SETTINGS_KEY = 'mountain-check.settings';
const DEFAULTS = {
  units: /^en-(US|LR|MM)$/.test(navigator.language) ? 'imperial' : 'metric',
  radius: 100000,
  skyline: true,
  fov: 66,          // camera field of view along the long side of the frame
  headingOffset: 0, // manual compass correction, degrees
  pitchOffset: 0,
};
const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {}); } catch { /* defaults */ }
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ok */ } };

// --- State ---------------------------------------------------------------------

const state = {
  camera: false,
  fix: null,            // latest GPS fix
  manual: null,         // chosen viewpoint, overrides GPS
  look: { heading: 0, pitch: 4 }, // used while there is no motion sensor
  loaded: null,         // { lat, lon, radius } the current data was fetched for
  peaksInfo: null,
  terrain: null,
  obs: null,
  visible: [],
  horizon: null,
  hits: [],
  selected: null,
  calibrating: false,
  loadGen: 0,
  computeGen: 0,
  retryAfter: 0,
  startedAt: 0,
};
const orientation = new Orientation();
globalThis.__mc = state; // handy when debugging from the console
const location_ = () => state.manual ?? state.fix;

// --- Small UI helpers ------------------------------------------------------------

function setStatus(kind, text, retry = false) {
  const el = $('status');
  el.hidden = false;
  el.dataset.state = kind;
  $('status-text').textContent = text;
  $('status-retry').hidden = !retry;
}

let toastTimer;
function toast(text, ms = 3500) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function closePanels() {
  $('sheet').hidden = true;
  $('settings').hidden = true;
  state.selected = null;
}

// --- Data loading ----------------------------------------------------------------

function onLocation() {
  const loc = location_();
  if (!loc) return;
  const c = state.loaded;
  if (!c || c.radius !== settings.radius || haversine(loc.lat, loc.lon, c.lat, c.lon) > settings.radius * 0.12) {
    if (Date.now() >= state.retryAfter) reload(loc);
  } else if (state.obs && haversine(loc.lat, loc.lon, state.obs.lat, state.obs.lon) > 75) {
    recompute(loc);
  }
}

async function reload(loc) {
  const gen = ++state.loadGen;
  const radius = settings.radius;
  state.loaded = { lat: loc.lat, lon: loc.lon, radius };
  state.obs = null;
  setStatus('busy', 'Loading peaks and terrain…');
  const [pk, tr] = await Promise.allSettled([
    loadPeaks(loc.lat, loc.lon, radius),
    loadTerrain(loc.lat, loc.lon, radius, (done, total) => {
      if (gen === state.loadGen) setStatus('busy', `Loading terrain ${done} of ${total}…`);
    }),
  ]);
  if (gen !== state.loadGen) return;
  if (pk.status === 'rejected') {
    state.loaded = null;
    state.retryAfter = Date.now() + 60000;
    setStatus('error', 'Could not load nearby peaks. Check your signal.', true);
    return;
  }
  state.peaksInfo = pk.value;
  state.terrain = tr.status === 'fulfilled' ? tr.value : null;
  await recompute(location_() ?? loc);
}

async function recompute(loc) {
  if (!state.peaksInfo) return;
  const gen = ++state.computeGen;
  const radius = settings.radius;
  const sample = state.terrain?.sample ?? null;
  const obs = {
    lat: loc.lat,
    lon: loc.lon,
    h: sample ? observerHeight(sample, loc.lat, loc.lon, loc.altitude) : (loc.altitude ?? 0),
  };
  state.obs ??= obs; // stops repeat triggers while this run is in progress
  setStatus('busy', 'Checking sightlines…');
  const steps = sample ? rayDistances(radius, Math.max(30, state.terrain.nearStep), state.terrain.farStep) : [];
  const out = [];
  const peaks = state.peaksInfo.peaks;
  for (let i = 0; i < peaks.length; i++) {
    const a = assessPeak(peaks[i], obs, sample, steps);
    if (a.visible && a.dist <= radius) {
      a.score = peakScore(a);
      out.push(a);
    }
    if (i % 250 === 249) {
      await new Promise((r) => setTimeout(r));
      if (gen !== state.computeGen) return;
    }
  }
  out.sort((a, b) => b.score - a.score);
  state.obs = obs;
  state.visible = out;
  state.horizon = sample ? computeHorizon(obs, sample, radius, steps) : null;
  refreshStatus();
}

function refreshStatus() {
  if (!state.obs || !state.peaksInfo) return;
  const parts = [`${state.visible.length} ${state.visible.length === 1 ? 'peak' : 'peaks'} in sight`];
  let kind = 'ok';
  if (!state.manual && state.fix) {
    const acc = settings.units === 'imperial' ? `${Math.round(state.fix.accuracy * 3.28084)} ft` : `${Math.round(state.fix.accuracy)} m`;
    parts.push(`GPS ±${acc}`);
    if (state.fix.accuracy > 100) kind = 'warn';
  }
  if (state.peaksInfo.source === 'offline') {
    parts.push(`saved ${new Date(state.peaksInfo.time).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`);
    kind = 'warn';
  }
  if (!state.terrain) {
    parts.push('no terrain data, hidden peaks may show');
    kind = 'warn';
  } else if (!state.terrain.complete) {
    parts.push('terrain incomplete');
    kind = 'warn';
  }
  if (sensorsExpected && orientation.source !== 'compass' && Date.now() - state.startedAt > 4000) {
    parts.push(orientation.source ? 'compass not calibrated, tap Align' : 'no compass, drag to look');
    kind = 'warn';
  }
  setStatus(kind, parts.join(' · '));
}

// --- View ----------------------------------------------------------------------

let safeTop = 0;
function measure() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top,0px);visibility:hidden';
  document.body.append(probe);
  safeTop = probe.getBoundingClientRect().height;
  probe.remove();
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
}
addEventListener('resize', measure);

function currentView(w, h) {
  let f;
  if (state.camera && video.videoWidth) {
    // The video is shown "cover" style, so scale its focal length the same way.
    const cover = Math.max(w / video.videoWidth, h / video.videoHeight);
    f = focalLength(settings.fov, Math.max(video.videoWidth, video.videoHeight)) * cover;
  } else {
    f = focalLength(settings.fov, Math.max(w, h));
  }
  if (orientation.source) {
    return {
      heading: wrap360(orientation.heading + settings.headingOffset),
      pitch: orientation.pitch + settings.pitchOffset,
      roll: orientation.roll,
      f,
    };
  }
  return { heading: state.look.heading, pitch: state.look.pitch, roll: 0, f };
}

function sceneOptions() {
  return {
    backdrop: !state.camera,
    skyline: state.calibrating || (settings.skyline && state.camera),
    top: safeTop,
    selectedId: state.selected?.peak.id,
  };
}

function frame() {
  const w = innerWidth, h = innerHeight;
  const dpr = canvas.width / w;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  state.view = currentView(w, h);
  state.hits = drawScene(ctx, w, h, state.view, { visible: state.visible, horizon: state.horizon, units: settings.units }, sceneOptions());
  requestAnimationFrame(frame);
}

// --- Touch: tap a label, drag to look around or to calibrate -------------------------

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 8) return;
  drag.moved = true;
  drag.x = e.clientX;
  drag.y = e.clientY;
  const degPerPx = Math.atan(1 / state.view.f) * R2D;
  if (!orientation.source) {
    state.look.heading = wrap360(state.look.heading - dx * degPerPx);
    state.look.pitch = Math.max(-45, Math.min(60, state.look.pitch + dy * degPerPx));
  } else if (state.calibrating) {
    settings.headingOffset = ((settings.headingOffset - dx * degPerPx + 540) % 360) - 180;
    settings.pitchOffset = Math.max(-30, Math.min(30, settings.pitchOffset + dy * degPerPx));
  }
});
canvas.addEventListener('pointerup', (e) => {
  const wasDrag = drag?.moved;
  drag = null;
  if (wasDrag) { if (state.calibrating) saveSettings(); return; }
  const hit = [...state.hits].reverse().find((b) => e.clientX >= b.x && e.clientX <= b.x + b.w && e.clientY >= b.y && e.clientY <= b.y + b.h);
  closePanels();
  if (hit) showPeak(hit.item);
});
canvas.addEventListener('pointercancel', () => { drag = null; });

// --- Peak details -----------------------------------------------------------------

function showPeak(a) {
  const p = a.peak, u = settings.units;
  state.selected = a;
  $('settings').hidden = true;
  $('sheet-kind').textContent = p.volcano ? 'Volcano' : 'Summit';
  $('sheet-name').textContent = p.name;
  const big = $('sheet-height');
  big.textContent = (Number.isFinite(p.ele) ? '' : '~') + formatHeight(a.height, u);
  const alt = document.createElement('small');
  alt.textContent = formatHeight(a.height, u === 'metric' ? 'imperial' : 'metric');
  big.append(alt);

  const rise = a.height - state.obs.h;
  const facts = [
    ['Distance', formatDistance(a.dist, u)],
    ['Direction', `${Math.round(a.bearing) % 360}° ${cardinal(a.bearing)}`],
    [rise >= 0 ? 'Above you' : 'Below you', formatHeight(Math.abs(rise), u)],
  ];
  if (p.prominence) facts.push(['Prominence', formatHeight(p.prominence, u)]);
  facts.push(['Coordinates', `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`]);
  if (!Number.isFinite(p.ele)) facts.push(['Height source', 'Estimated from terrain']);
  $('sheet-facts').replaceChildren(...facts.map(([k, v]) => {
    const div = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    div.append(dt, dd);
    return div;
  }));

  const links = [];
  if (p.wikipedia?.includes(':')) {
    const i = p.wikipedia.indexOf(':');
    const lang = p.wikipedia.slice(0, i), title = p.wikipedia.slice(i + 1).replace(/ /g, '_');
    if (/^[a-z-]{2,12}$/.test(lang)) links.push(['Wikipedia', `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`]);
  } else if (/^Q\d+$/.test(p.wikidata ?? '')) {
    links.push(['Wikidata', `https://www.wikidata.org/wiki/${p.wikidata}`]);
  }
  links.push(['Map', `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=13/${p.lat}/${p.lon}`]);
  $('sheet-links').replaceChildren(...links.map(([label, href]) => {
    const el = document.createElement('a');
    el.textContent = label;
    el.href = href;
    el.target = '_blank';
    el.rel = 'noopener';
    return el;
  }));
  $('sheet').hidden = false;
}

// --- Photo ----------------------------------------------------------------------

async function capture() {
  const w = innerWidth, h = innerHeight;
  const hasVideo = state.camera && video.videoWidth;
  const cover = hasVideo ? Math.max(w / video.videoWidth, h / video.videoHeight) : 1;
  const s = hasVideo ? Math.min(3, Math.max(2, 1 / cover)) : 2;
  const out = document.createElement('canvas');
  out.width = Math.round(w * s);
  out.height = Math.round(h * s);
  const c = out.getContext('2d');
  if (hasVideo) {
    const sw = w / cover, sh = h / cover;
    c.drawImage(video, (video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh, 0, 0, out.width, out.height);
  }
  c.scale(s, s);
  drawScene(c, w, h, state.view, { visible: state.visible, horizon: state.horizon, units: settings.units },
    { ...sceneOptions(), skyline: false, selectedId: null });

  // Caption: where the photo was taken from and which way it faces.
  const loc = state.obs ?? location_();
  if (loc) {
    const ns = loc.lat >= 0 ? 'N' : 'S', ew = loc.lon >= 0 ? 'E' : 'W';
    const bits = [`${Math.abs(loc.lat).toFixed(4)}° ${ns}, ${Math.abs(loc.lon).toFixed(4)}° ${ew}`];
    if (Number.isFinite(loc.h)) bits.push(formatHeight(loc.h, settings.units));
    bits.push(`facing ${Math.round(state.view.heading) % 360}° ${cardinal(state.view.heading)}`);
    bits.push(new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));
    const g = c.createLinearGradient(0, h - 60, 0, h);
    g.addColorStop(0, 'rgba(8,13,18,0)');
    g.addColorStop(1, 'rgba(8,13,18,0.8)');
    c.fillStyle = g;
    c.fillRect(0, h - 60, w, 60);
    c.font = '500 11px system-ui, -apple-system, sans-serif';
    c.textAlign = 'center';
    c.fillStyle = '#fff';
    c.fillText(bits.join('  ·  '), w / 2, h - 14, w - 24);
  }

  const flash = Object.assign(document.createElement('div'), { id: 'flash' });
  document.body.append(flash);
  setTimeout(() => flash.remove(), 300);

  const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) { toast('Could not create the photo.'); return; }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = new File([blob], `mountain-check-${stamp}.jpg`, { type: 'image/jpeg' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // share sheet dismissed
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast('Photo saved to your downloads.');
}

// --- Controls ---------------------------------------------------------------------

function syncControls() {
  for (const b of $('units').children) b.setAttribute('aria-pressed', b.dataset.v === settings.units);
  for (const b of $('radius').children) {
    b.setAttribute('aria-pressed', Number(b.dataset.v) === settings.radius);
    b.textContent = formatDistance(Number(b.dataset.v), settings.units).replace('.0', '');
  }
  $('skyline').checked = settings.skyline;
  $('fov').value = settings.fov;
  $('fov-out').textContent = `${settings.fov}°`;
  $('btn-calib').setAttribute('aria-pressed', state.calibrating);
  $('calib').hidden = !state.calibrating;
}

$('units').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v) return;
  settings.units = v;
  saveSettings(); syncControls(); refreshStatus();
});
$('radius').addEventListener('click', (e) => {
  const v = Number(e.target.closest('button')?.dataset.v);
  if (!v || v === settings.radius) return;
  settings.radius = v;
  saveSettings(); syncControls();
  state.retryAfter = 0;
  onLocation();
});
$('skyline').addEventListener('change', (e) => { settings.skyline = e.target.checked; saveSettings(); });
$('fov').addEventListener('input', (e) => { settings.fov = Number(e.target.value); syncControls(); });
$('fov').addEventListener('change', saveSettings);

$('btn-settings').addEventListener('click', () => {
  const open = $('settings').hidden;
  closePanels();
  $('settings').hidden = !open;
});
$('btn-calib').addEventListener('click', () => {
  closePanels();
  state.calibrating = !state.calibrating;
  syncControls();
});
$('calib-done').addEventListener('click', () => { state.calibrating = false; saveSettings(); syncControls(); });
$('calib-reset').addEventListener('click', () => {
  settings.headingOffset = 0;
  settings.pitchOffset = 0;
  settings.fov = DEFAULTS.fov;
  saveSettings(); syncControls();
});
$('btn-shot').addEventListener('click', capture);
$('status-retry').addEventListener('click', () => { const loc = location_(); if (loc) reload(loc); });
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closePanels(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanels(); });

function setViewpoint(lat, lon) {
  state.manual = { lat, lon };
  state.retryAfter = 0;
  onLocation();
}
$('place').addEventListener('change', (e) => {
  const v = e.target.value;
  $('custom').hidden = v !== 'custom';
  if (v === 'custom') return;
  if (v === 'gps') {
    state.manual = null;
    state.retryAfter = 0;
    if (!stopWatch) beginLocation();
    else if (state.fix) onLocation();
    else setStatus('busy', 'Finding your location…');
  } else {
    const [lat, lon] = v.split(',').map(Number);
    setViewpoint(lat, lon);
  }
});
$('custom-go').addEventListener('click', () => {
  const lat = parseFloat($('custom-lat').value), lon = parseFloat($('custom-lon').value);
  if (!(Math.abs(lat) <= 85) || !(Math.abs(lon) <= 180)) { toast('Enter a latitude between -85 and 85 and a longitude between -180 and 180.'); return; }
  setViewpoint(lat, lon);
  $('settings').hidden = true;
});

// --- Start ----------------------------------------------------------------------

let stopWatch = null;
let sensorsExpected = false;

function beginLocation() {
  setStatus('busy', 'Finding your location…');
  stopWatch = watchLocation(
    (fix) => {
      // Once there is a decent fix, ignore the occasional wild one.
      if (state.fix && fix.accuracy > 150 && fix.accuracy > state.fix.accuracy * 2) return;
      state.fix = fix;
      if (!state.manual) onLocation();
    },
    (err) => {
      if (state.fix || state.manual) return;
      if (err.code === 1 || err.message === 'unsupported') {
        setStatus('error', 'Location is off. Allow it for this site, or pick a viewpoint in Settings.');
        stopWatch?.();
        stopWatch = null;
      } else {
        setStatus('busy', 'Still looking for a GPS fix…');
      }
    },
  );
}

async function start(sample) {
  state.startedAt = Date.now();
  measure();
  syncControls();
  if (sample) {
    $('place').value = '45.9836,7.7846';
    state.look = { heading: 228, pitch: 5 };
    setViewpoint(45.9836, 7.7846);
    toast('Sample view from Gornergrat. Drag to look around.', 5000);
  } else {
    sensorsExpected = true;
    const motion = await orientation.start(); // first, while the tap still counts
    startCamera(video)
      .then(() => { state.camera = true; })
      .catch(() => toast('Camera unavailable. Showing a drawn skyline instead.', 5000));
    beginLocation();
    keepAwake();
    if (!motion) toast('Motion access was not granted, so drag to look around.', 5000);
  }
  $('start').hidden = true;
  $('bar').hidden = false;
  requestAnimationFrame(frame);
  setInterval(() => { if ($('status').dataset.state !== 'busy' && $('status').dataset.state !== 'error') refreshStatus(); }, 2000);
}

$('go').addEventListener('click', () => start(false));
$('demo').addEventListener('click', () => start(true));
if (!isSecureContext) {
  $('start-note').textContent = 'Open this page over https: browsers only allow the camera, location and compass on secure pages.';
}
if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
