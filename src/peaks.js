// Named summits from OpenStreetMap via the Overpass API, cached per area so
// the app keeps working after the signal drops.

import { haversine } from './geo.js';
import { DATA_CACHE } from './dem.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const INDEX_KEY = 'mountain-check.areas';
const FRESH_MS = 30 * 24 * 3600 * 1000;
const MAX_AREAS = 8;
// Every named summit inside this distance; beyond it only notable ones (those
// with a Wikidata entry), which keeps a 200 km request to a sensible size.
const FULL_DETAIL_RADIUS = 100000;

export function buildQuery(lat, lon, radius) {
  const at = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const kind = 'node["natural"~"^(peak|volcano)$"]["name"]';
  const inner = Math.min(radius, FULL_DETAIL_RADIUS);
  let q = `[out:json][timeout:60];(${kind}(around:${inner},${at});`;
  if (radius > inner) q += `${kind}["wikidata"](around:${radius},${at});`;
  return q + ');out body qt;';
}

function parseNumber(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(',', '.').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function parseElements(elements) {
  const peaks = [];
  for (const e of elements ?? []) {
    const t = e.tags;
    if (e.type !== 'node' || !t?.name) continue;
    const p = { id: e.id, name: t.name, lat: e.lat, lon: e.lon };
    const ele = parseNumber(t.ele);
    if (ele != null && ele > -500 && ele < 9000) p.ele = ele;
    const prom = parseNumber(t.prominence);
    if (prom != null && prom > 0) p.prominence = prom;
    if (t.wikipedia) p.wikipedia = t.wikipedia;
    if (t.wikidata) p.wikidata = t.wikidata;
    if (t.natural === 'volcano') p.volcano = true;
    peaks.push(p);
  }
  return peaks;
}

function readIndex() {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY)) ?? []; } catch { return []; }
}
function writeIndex(list) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(list)); } catch { /* private mode */ }
}
const areaUrl = (key) => new URL(`./__peaks/${key}.json`, location.href).href;

async function readArea(area) {
  try {
    const cache = await caches.open(DATA_CACHE);
    const res = await cache.match(areaUrl(area.key));
    return res ? await res.json() : null;
  } catch { return null; }
}

async function saveArea(lat, lon, radius, peaks) {
  try {
    const key = `${lat.toFixed(3)}_${lon.toFixed(3)}_${Math.round(radius / 1000)}`;
    const cache = await caches.open(DATA_CACHE);
    await cache.put(areaUrl(key), new Response(JSON.stringify(peaks), { headers: { 'Content-Type': 'application/json' } }));
    const list = readIndex().filter((a) => a.key !== key);
    list.push({ key, lat, lon, radius, time: Date.now() });
    while (list.length > MAX_AREAS) {
      const old = list.shift();
      cache.delete(areaUrl(old.key)).catch(() => {});
    }
    writeIndex(list);
  } catch { /* caching is best effort */ }
}

/** Closest saved area that still covers the observer well enough. */
function findArea(lat, lon, radius, maxOffsetFraction, maxAge) {
  let best = null;
  for (const a of readIndex()) {
    if (a.radius < radius * 0.99) continue;
    if (Date.now() - a.time > maxAge) continue;
    const off = haversine(lat, lon, a.lat, a.lon);
    if (off > a.radius * maxOffsetFraction) continue;
    if (!best || off < best.off) best = { ...a, off };
  }
  return best;
}

async function fetchOverpass(query) {
  let lastError;
  for (const url of ENDPOINTS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 45000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const json = await res.json();
      return parseElements(json.elements);
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error('Peak lookup failed');
}

/**
 * Peaks around a point. Uses a recent nearby download when there is one,
 * otherwise asks OpenStreetMap, and falls back to any older saved area that
 * still covers the spot when the network is unavailable.
 * Returns { peaks, source: 'live' | 'saved' | 'offline', time, center }.
 */
export async function loadPeaks(lat, lon, radius) {
  const recent = findArea(lat, lon, radius, 0.12, FRESH_MS);
  if (recent) {
    const peaks = await readArea(recent);
    if (peaks) return { peaks, source: 'saved', time: recent.time, center: recent };
  }
  try {
    const peaks = await fetchOverpass(buildQuery(lat, lon, radius));
    saveArea(lat, lon, radius, peaks);
    return { peaks, source: 'live', time: Date.now(), center: { lat, lon } };
  } catch (err) {
    const old = findArea(lat, lon, radius * 0.5, 0.6, Infinity);
    if (old) {
      const peaks = await readArea(old);
      if (peaks) return { peaks, source: 'offline', time: old.time, center: old };
    }
    throw err;
  }
}
