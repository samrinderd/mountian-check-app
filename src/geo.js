// Pure geometry: great-circle maths, earth curvature, Web Mercator, and the
// camera projection. No DOM access, so it runs under `node --test`.

export const R_EARTH = 6371008.8; // mean radius, metres
// Standard atmospheric refraction bends sightlines down slightly, which makes
// distant summits appear a little higher than pure geometry predicts.
export const REFRACTION = 0.13;
export const CURVE = (1 - REFRACTION) / (2 * R_EARTH);

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

export const wrap360 = (d) => ((d % 360) + 360) % 360;

/** Signed smallest difference a - b in degrees, in (-180, 180]. */
export function angleDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function haversine(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R;
  const dp = p2 - p1, dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from point 1 to point 2, degrees clockwise from true north. */
export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return wrap360(Math.atan2(y, x) * R2D);
}

export function destination(lat, lon, brg, dist) {
  const d = dist / R_EARTH, b = brg * D2R, p1 = lat * D2R, l1 = lon * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 * R2D, lon: ((l2 * R2D + 540) % 360) - 180 };
}

/**
 * Apparent slope (tan of the elevation angle) of something `hTarget` metres
 * high at `dist` metres, seen from `hObserver`, after curvature and refraction.
 */
export function apparentSlope(dist, hTarget, hObserver) {
  return (hTarget - hObserver - CURVE * dist * dist) / dist;
}

// --- Web Mercator, in pixels of 256px tiles at zoom z -----------------------

export const lonToPx = (lon, z) => ((lon + 180) / 360) * 256 * 2 ** z;
export function latToPy(lat, z) {
  const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * D2R);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z;
}
export const metresPerPixel = (lat, z) => (40075016.686 * Math.cos(lat * D2R)) / (256 * 2 ** z);

// --- Device orientation ------------------------------------------------------

/**
 * Compass heading of the phone's back camera from W3C deviceorientation angles
 * (alpha must be earth-referenced). Degrees clockwise from north.
 */
export function compassHeading(alpha, beta, gamma) {
  const z = alpha * D2R, x = beta * D2R, y = gamma * D2R;
  const cX = Math.cos(x), cY = Math.cos(y), cZ = Math.cos(z);
  const sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
  const vx = -cZ * sY - sZ * sX * cY;
  const vy = -sZ * sY + cZ * sX * cY;
  return wrap360(Math.atan2(vx, vy) * R2D);
}

/**
 * Camera pitch (degrees above the horizon) and roll (degrees, positive when
 * the phone's right edge is raised). Both come from gravity alone, so they
 * stay trustworthy even when the compass does not.
 */
export function pitchRoll(beta, gamma) {
  const b = beta * D2R, g = gamma * D2R;
  const pitch = Math.asin(Math.max(-1, Math.min(1, -Math.cos(b) * Math.cos(g)))) * R2D;
  const roll = Math.atan2(-Math.sin(g) * Math.cos(b), Math.sin(b)) * R2D;
  return { pitch, roll };
}

// --- Projection ----------------------------------------------------------------

/**
 * Pinhole camera looking along `heading`/`pitch`, rotated by `roll`.
 * `f` is the focal length in screen pixels. Returns a function mapping a
 * direction (azimuth, elevation in degrees) to screen x/y, or null when the
 * direction is behind the camera.
 */
export function makeCamera({ heading, pitch, roll, f, cx, cy }) {
  const h = heading * D2R, p = pitch * D2R, r = roll * D2R;
  const sh = Math.sin(h), ch = Math.cos(h), sp = Math.sin(p), cp = Math.cos(p);
  const sr = Math.sin(r), cr = Math.cos(r);
  // East-North-Up basis vectors of the un-rolled camera.
  const F = [sh * cp, ch * cp, sp];
  const R0 = [ch, -sh, 0];
  const U0 = [-sh * sp, -ch * sp, cp];
  const Rv = [R0[0] * cr + U0[0] * sr, R0[1] * cr + U0[1] * sr, R0[2] * cr + U0[2] * sr];
  const Uv = [-R0[0] * sr + U0[0] * cr, -R0[1] * sr + U0[1] * cr, -R0[2] * sr + U0[2] * cr];
  return function project(az, el) {
    const a = az * D2R, e = el * D2R, ce = Math.cos(e);
    const d0 = Math.sin(a) * ce, d1 = Math.cos(a) * ce, d2 = Math.sin(e);
    const z = d0 * F[0] + d1 * F[1] + d2 * F[2];
    if (z <= 0.05) return null;
    const x = d0 * Rv[0] + d1 * Rv[1] + d2 * Rv[2];
    const y = d0 * Uv[0] + d1 * Uv[1] + d2 * Uv[2];
    return { x: cx + (f * x) / z, y: cy - (f * y) / z };
  };
}

/** Focal length in pixels for a field of view (degrees) spanning `size` pixels. */
export const focalLength = (fovDeg, size) => size / 2 / Math.tan((fovDeg * D2R) / 2);

const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const cardinal = (deg) => CARDINALS[Math.round(wrap360(deg) / 22.5) % 16];
