// Terrain-aware visibility: which peaks have a clear sightline, and where the
// skyline sits in every direction. Works on any `sample(lat, lon) -> metres`
// function, so it is testable without real elevation tiles.

import { apparentSlope, bearing, CURVE, destination, haversine, R2D } from './geo.js';

const EYE_HEIGHT = 1.7;
// A sightline may graze terrain by this much slope (about 0.06 degrees) and
// still count as clear; elevation tiles smooth ridges slightly.
const SLOPE_TOLERANCE = 0.001;

/** Distances to sample along a ray: fine near the observer, coarser far away. */
export function rayDistances(maxDist, nearStep, farStep) {
  const out = [];
  let d = nearStep;
  while (d < maxDist) {
    out.push(d);
    d += Math.min(farStep, Math.max(nearStep, d * 0.02));
  }
  return out;
}

export function observerHeight(sample, lat, lon, gpsAltitude) {
  const ground = sample(lat, lon);
  if (Number.isFinite(ground)) return ground + EYE_HEIGHT;
  return Number.isFinite(gpsAltitude) ? gpsAltitude : 0;
}

/**
 * Fills in dist/bearing/elevation angle for one peak and decides whether the
 * terrain between the observer and the summit leaves it in view.
 */
export function assessPeak(peak, obs, sample, steps) {
  const dist = haversine(obs.lat, obs.lon, peak.lat, peak.lon);
  const demHeight = sample ? sample(peak.lat, peak.lon) : NaN;
  // Tiles underestimate sharp summits, so trust a surveyed height when present.
  const height = Number.isFinite(peak.ele)
    ? Math.max(peak.ele, Number.isFinite(demHeight) ? demHeight : -Infinity)
    : demHeight;
  const res = { peak, dist, bearing: bearing(obs.lat, obs.lon, peak.lat, peak.lon), height, visible: false, el: 0 };
  if (!Number.isFinite(height) || dist < 150) return res;

  const slope = apparentSlope(dist, height, obs.h);
  res.el = Math.atan(slope) * R2D;
  if (!sample) {
    // No terrain data: only the curve of the earth can hide a peak. It is in
    // view when it rises above the sightline that grazes the sea-level horizon.
    const beyond = dist - Math.sqrt(Math.max(0, obs.h) / CURVE);
    res.visible = beyond <= 0 || height >= CURVE * beyond * beyond;
    return res;
  }
  // Ignore the summit's own upper slopes when looking for obstructions.
  const stop = dist - Math.max(250, dist * 0.04);
  const dLat = peak.lat - obs.lat, dLon = peak.lon - obs.lon;
  for (let i = 0; i < steps.length; i++) {
    const d = steps[i];
    if (d >= stop) break;
    const t = d / dist;
    const h = sample(obs.lat + dLat * t, obs.lon + dLon * t);
    if (h !== h) continue; // NaN: no data here
    if (apparentSlope(d, h, obs.h) > slope + SLOPE_TOLERANCE) return res;
  }
  res.visible = true;
  return res;
}

/**
 * Skyline profile: for each of `n` evenly spaced azimuths, the elevation angle
 * (degrees) of the highest terrain along that ray.
 */
export function computeHorizon(obs, sample, maxDist, steps, n = 1440) {
  const angles = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const end = destination(obs.lat, obs.lon, (i * 360) / n, maxDist);
    const dLat = end.lat - obs.lat;
    let dLon = end.lon - obs.lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    let best = -0.2;
    for (let k = 0; k < steps.length; k++) {
      const d = steps[k], t = d / maxDist;
      const h = sample(obs.lat + dLat * t, obs.lon + dLon * t);
      if (h !== h) continue;
      const s = apparentSlope(d, h, obs.h);
      if (s > best) best = s;
    }
    angles[i] = Math.atan(best) * R2D;
  }
  return angles;
}

/** Linear interpolation into a horizon profile at an arbitrary azimuth. */
export function horizonAt(angles, az) {
  const n = angles.length;
  const x = ((((az % 360) + 360) % 360) / 360) * n;
  const i = Math.floor(x) % n, f = x - Math.floor(x);
  return angles[i] * (1 - f) + angles[(i + 1) % n] * f;
}

/** How strongly a peak deserves a label when space is tight. */
export function peakScore(a) {
  const p = a.peak;
  let s = Math.max(0, a.height) / (1 + a.dist / 60000);
  if (p.prominence) s += Math.min(p.prominence, 2000) * 1.5;
  if (p.wikipedia || p.wikidata) s *= 1.5;
  return s;
}
