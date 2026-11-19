import test from 'node:test';
import assert from 'node:assert/strict';
import { angleDiff, apparentSlope, bearing, compassHeading, destination, haversine, makeCamera, pitchRoll, R2D } from '../src/geo.js';
import { assessPeak, computeHorizon, horizonAt, rayDistances } from '../src/visibility.js';
import { buildQuery, parseElements } from '../src/peaks.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}±${tol}, got ${a}`);

test('distance and bearing: Gornergrat to Matterhorn', () => {
  const d = haversine(45.9836, 7.7846, 45.9764, 7.6586);
  near(d, 9790, 80);
  near(bearing(45.9836, 7.7846, 45.9764, 7.6586), 265.3, 0.5);
});

test('destination inverts bearing and distance', () => {
  const p = destination(46, 8, 73, 50000);
  near(haversine(46, 8, p.lat, p.lon), 50000, 1);
  near(bearing(46, 8, p.lat, p.lon), 73, 0.01);
});

test('angleDiff wraps across north', () => {
  assert.equal(angleDiff(5, 355), 10);
  assert.equal(angleDiff(355, 5), -10);
});

test('earth curvature hides a low target: sea-level horizon from 100 m is about 38 km away', () => {
  // With standard refraction the horizon distance is sqrt(2*R*h/(1-k)).
  assert.ok(apparentSlope(38300, 0, 100) > apparentSlope(30000, 0, 100));
  assert.ok(apparentSlope(38300, 0, 100) > apparentSlope(50000, 0, 100));
  const dip = Math.atan(apparentSlope(38300, 0, 100)) * R2D;
  near(dip, -0.30, 0.02);
});

test('device held upright: heading follows the back camera', () => {
  // Upright portrait (beta 90). alpha 0 means the back camera faces north.
  near(compassHeading(0, 90, 0), 0, 1e-6);
  near(compassHeading(270, 90, 0), 90, 1e-6); // alpha grows counter-clockwise
  near(compassHeading(90, 90, 0), 270, 1e-6);
  // Lying flat, screen up, top edge to the north: the camera faces down, and
  // tilting it up slightly should look north.
  near(compassHeading(0, 45, 0), 0, 1e-6);
});

test('pitch and roll from gravity', () => {
  near(pitchRoll(90, 0).pitch, 0, 1e-9);
  near(pitchRoll(110, 0).pitch, 20, 1e-9);   // tilted back: camera looks up
  near(pitchRoll(70, 0).pitch, -20, 1e-9);
  near(pitchRoll(90, 0).roll, 0, 1e-9);
  // Roughly upright but twisted: right edge lifted means positive roll.
  assert.ok(pitchRoll(60, -30).roll > 5);
  assert.ok(pitchRoll(60, 30).roll < -5);
});

test('camera projection', () => {
  const cam = makeCamera({ heading: 90, pitch: 0, roll: 0, f: 500, cx: 200, cy: 400 });
  const c = cam(90, 0);
  near(c.x, 200, 1e-6); near(c.y, 400, 1e-6);
  assert.ok(cam(100, 0).x > 200, 'east-south-east is right of east');
  assert.ok(cam(90, 5).y < 400, 'above the horizon is up the screen');
  near(cam(100, 0).x - 200, 500 * Math.tan(10 / R2D), 1e-6);
  assert.equal(cam(270, 0), null, 'behind the camera');
  // Phone's right edge raised: the world appears rotated clockwise, so a point
  // to the right on the horizon shows lower on the screen.
  const rolled = makeCamera({ heading: 90, pitch: 0, roll: 10, f: 500, cx: 200, cy: 400 });
  assert.ok(rolled(100, 0).y > 400);
  // Looking up moves the horizon down the screen.
  const up = makeCamera({ heading: 90, pitch: 10, roll: 0, f: 500, cx: 200, cy: 400 });
  assert.ok(up(90, 0).y > 400);
});

test('a ridge blocks the peak behind it but not the one in front', () => {
  // Flat ground at 1000 m with a 2000 m wall 0.1 degrees of latitude north.
  const sample = (lat) => (lat > 46.098 && lat < 46.102 ? 2000 : 1000);
  const obs = { lat: 46, lon: 8, h: 1002 };
  const steps = rayDistances(60000, 50, 200);
  const front = assessPeak({ lat: 46.05, lon: 8, ele: 1500 }, obs, sample, steps);
  const hidden = assessPeak({ lat: 46.2, lon: 8, ele: 2400 }, obs, sample, steps);
  const tall = assessPeak({ lat: 46.2, lon: 8, ele: 3600 }, obs, sample, steps);
  assert.equal(front.visible, true);
  assert.equal(hidden.visible, false);
  assert.equal(tall.visible, true);
  near(front.bearing, 0, 0.01);

  const horizon = computeHorizon(obs, sample, 60000, steps, 360);
  near(horizonAt(horizon, 0), Math.atan(apparentSlope(10900, 2000, 1002)) * R2D, 0.15, 'north skyline is the wall');
  assert.ok(horizonAt(horizon, 180) < 0.1, 'south is flat');
});

test('peaks without terrain data are only hidden by curvature', () => {
  const obs = { lat: 46, lon: 8, h: 2 };
  assert.equal(assessPeak({ lat: 46.3, lon: 8, ele: 3000 }, obs, null, []).visible, true);
  assert.equal(assessPeak({ lat: 48.5, lon: 8, ele: 300 }, obs, null, []).visible, false);
});

test('Overpass query and parsing', () => {
  const q = buildQuery(45.98361, 7.78461, 200000);
  assert.match(q, /around:100000,45\.9836,7\.7846/);
  assert.match(q, /\["wikidata"\]\(around:200000/);
  assert.doesNotMatch(buildQuery(45, 7, 50000), /wikidata/);
  const peaks = parseElements([
    { type: 'node', id: 1, lat: 45.9764, lon: 7.6586, tags: { natural: 'peak', name: 'Matterhorn', ele: '4478', prominence: '1042', wikipedia: 'en:Matterhorn' } },
    { type: 'node', id: 2, lat: 46, lon: 7.7, tags: { natural: 'peak', name: 'No height' } },
    { type: 'node', id: 3, lat: 46, lon: 7.7, tags: { natural: 'peak', name: 'Odd', ele: '2 345,5 m' } },
    { type: 'node', id: 4, lat: 46, lon: 7.7, tags: { natural: 'peak' } },
  ]);
  assert.equal(peaks.length, 3);
  assert.deepEqual(peaks[0], { id: 1, name: 'Matterhorn', lat: 45.9764, lon: 7.6586, ele: 4478, prominence: 1042, wikipedia: 'en:Matterhorn' });
  assert.equal(peaks[1].ele, undefined);
  assert.equal(peaks[2].ele, 2345.5);
});
