// Phone sensors: compass + tilt, GPS, and the rear camera.

import { angleDiff, compassHeading, pitchRoll, wrap360 } from './geo.js';

/**
 * Tracks where the back camera points. `heading` is degrees from north,
 * `pitch` degrees above the horizon, `roll` degrees of sideways tilt.
 * `source` is 'compass' when the heading is earth-referenced, 'relative' when
 * the browser only reports motion from an arbitrary start (needs calibrating).
 */
export class Orientation {
  heading = 0; pitch = 0; roll = 0;
  source = null;
  accuracy = null;
  #last = 0;
  #gotAbsolute = false;

  /** Must be called from a tap: iOS only shows its motion prompt then. */
  async start() {
    const DOE = globalThis.DeviceOrientationEvent;
    if (!DOE) return false;
    if (typeof DOE.requestPermission === 'function') {
      try {
        if ((await DOE.requestPermission()) !== 'granted') return false;
      } catch { return false; }
    }
    addEventListener('deviceorientationabsolute', (e) => this.#onEvent(e, true));
    addEventListener('deviceorientation', (e) => this.#onEvent(e, false));
    return true;
  }

  #onEvent(e, absoluteEvent) {
    if (e.beta == null || e.gamma == null) return;
    let heading, source;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      // iOS: already a true compass heading.
      heading = e.webkitCompassHeading;
      source = 'compass';
      this.accuracy = e.webkitCompassAccuracy ?? null;
    } else if (e.alpha != null && (absoluteEvent || e.absolute)) {
      heading = compassHeading(e.alpha, e.beta, e.gamma);
      source = 'compass';
      this.#gotAbsolute = true;
    } else if (e.alpha != null && !this.#gotAbsolute) {
      heading = compassHeading(e.alpha, e.beta, e.gamma);
      source = 'relative';
    } else {
      return;
    }
    const { pitch, roll } = pitchRoll(e.beta, e.gamma);
    const screenAngle = screen.orientation?.angle ?? globalThis.orientation ?? 0;

    // Smooth out sensor jitter with a ~120 ms time constant.
    const now = performance.now();
    const k = this.source ? 1 - Math.exp(-(now - this.#last) / 120) : 1;
    this.#last = now;
    this.heading = wrap360(this.heading + angleDiff(heading, this.heading) * k);
    this.pitch += (pitch - this.pitch) * k;
    this.roll += angleDiff(roll - screenAngle, this.roll) * k;
    this.source = source;
  }
}

/** Watches GPS. Calls back with { lat, lon, altitude, accuracy }. */
export function watchLocation(onFix, onError) {
  if (!navigator.geolocation) { onError?.(new Error('unsupported')); return () => {}; }
  const id = navigator.geolocation.watchPosition(
    (p) => onFix({
      lat: p.coords.latitude,
      lon: p.coords.longitude,
      altitude: p.coords.altitude,
      accuracy: p.coords.accuracy,
    }),
    (err) => onError?.(err),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  video.srcObject = stream;
  await video.play().catch(() => {});
  return stream;
}

let wakeLock;
export async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock) keepAwake();
});
