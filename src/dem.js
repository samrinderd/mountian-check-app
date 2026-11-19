// Elevation data from the public "Terrarium" terrain tiles (Mapzen / AWS Open
// Data). Tiles are stitched into one grid per zoom level and kept in the
// browser's Cache Storage so a previously visited area works without signal.

import { D2R, latToPy, lonToPx, metresPerPixel, R_EARTH } from './geo.js';

const tileUrl = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const DATA_CACHE = 'mountain-check-data-v1';
const NO_DATA = -32768;
const MAX_CACHED_TILES = 600;

async function openCache() {
  try { return 'caches' in globalThis ? await caches.open(DATA_CACHE) : null; } catch { return null; }
}

async function fetchTile(cache, url) {
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return hit.blob();
  }
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`tile ${res.status}`);
  if (cache) cache.put(url, res.clone()).catch(() => {});
  return res.blob();
}

let scratch;
async function decodeTile(blob) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  } catch {
    bmp = await createImageBitmap(blob);
  }
  scratch ??= Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, 256, 256);
  ctx.drawImage(bmp, 0, 0, 256, 256);
  bmp.close?.();
  return ctx.getImageData(0, 0, 256, 256).data;
}

/** Highest zoom whose tiles cover a circle of `radius` within `maxTiles`. */
export function pickZoom(lat, radius, maxTiles, maxZoom = 12) {
  for (let z = maxZoom; z > 4; z--) {
    const tileWidth = metresPerPixel(lat, z) * 256;
    const n = Math.ceil((2 * radius) / tileWidth) + 1;
    if (n * n <= maxTiles) return z;
  }
  return 5;
}

/**
 * Loads every tile covering `radius` metres around a point and returns a grid
 * with a bilinear `sample(lat, lon)` (NaN outside the grid or where a tile
 * failed to load).
 */
export async function loadGrid(lat, lon, radius, z, onProgress) {
  const dLat = (radius / R_EARTH) / D2R;
  const dLon = dLat / Math.max(0.05, Math.cos(lat * D2R));
  const world = 2 ** z;
  const x0 = Math.floor(lonToPx(lon - dLon, z) / 256);
  const x1 = Math.floor(lonToPx(lon + dLon, z) / 256);
  const y0 = Math.max(0, Math.floor(latToPy(lat + dLat, z) / 256));
  const y1 = Math.min(world - 1, Math.floor(latToPy(lat - dLat, z) / 256));
  const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
  const w = nx * 256, h = ny * 256;
  const data = new Int16Array(w * h).fill(NO_DATA);

  const cache = await openCache();
  const jobs = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) jobs.push([tx, ty]);
  let done = 0, loaded = 0;
  const worker = async () => {
    while (jobs.length) {
      const [tx, ty] = jobs.pop();
      try {
        const wrappedX = ((tx % world) + world) % world;
        const px = await decodeTile(await fetchTile(cache, tileUrl(z, wrappedX, ty)));
        const ox = (tx - x0) * 256, oy = (ty - y0) * 256;
        for (let r = 0; r < 256; r++) {
          let o = (oy + r) * w + ox, i = r * 1024;
          for (let c = 0; c < 256; c++, i += 4, o++) {
            data[o] = Math.round(px[i] * 256 + px[i + 1] + px[i + 2] / 256 - 32768);
          }
        }
        loaded++;
      } catch { /* leave as NO_DATA */ }
      onProgress?.(++done, nx * ny);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (cache) pruneTiles(cache);

  const originX = x0 * 256, originY = y0 * 256;
  function sample(la, lo) {
    const fx = lonToPx(lo, z) - originX - 0.5, fy = latToPy(la, z) - originY - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    if (ix < 0 || iy < 0 || ix >= w - 1 || iy >= h - 1) return NaN;
    const o = iy * w + ix;
    const a = data[o], b = data[o + 1], c = data[o + w], d = data[o + w + 1];
    if (a === NO_DATA || b === NO_DATA || c === NO_DATA || d === NO_DATA) return NaN;
    const tx = fx - ix, ty = fy - iy;
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  return { z, sample, tiles: nx * ny, loaded, resolution: metresPerPixel(lat, z) };
}

async function pruneTiles(cache) {
  try {
    const keys = (await cache.keys()).filter((k) => k.url.includes('/terrarium/'));
    // Cache Storage lists entries oldest first.
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CACHED_TILES))) await cache.delete(k);
  } catch { /* best effort */ }
}

/**
 * Detailed terrain close to the observer plus coarser terrain out to the
 * viewing radius. Returns null when no tiles at all could be loaded.
 */
export async function loadTerrain(lat, lon, radius, onProgress) {
  const nearRadius = Math.min(12000, radius);
  const zNear = pickZoom(lat, nearRadius, 16);
  const zFar = Math.min(zNear, pickZoom(lat, radius, 25));
  let nearDone = 0, nearTotal = 0, farDone = 0, farTotal = 0;
  const report = () => onProgress?.(nearDone + farDone, nearTotal + farTotal);
  const [near, far] = await Promise.all([
    loadGrid(lat, lon, nearRadius, zNear, (d, t) => { nearDone = d; nearTotal = t; report(); }),
    radius > nearRadius
      ? loadGrid(lat, lon, radius, zFar, (d, t) => { farDone = d; farTotal = t; report(); })
      : null,
  ]);
  const loaded = near.loaded + (far?.loaded ?? 0);
  const tiles = near.tiles + (far?.tiles ?? 0);
  if (!loaded) return null;
  const sample = far
    ? (la, lo) => { const v = near.sample(la, lo); return v === v ? v : far.sample(la, lo); }
    : near.sample;
  return {
    sample,
    nearStep: near.resolution,
    farStep: (far ?? near).resolution,
    complete: loaded === tiles,
  };
}
