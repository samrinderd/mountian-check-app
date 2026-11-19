# Mountain Check

Point your phone at the horizon and see which mountain is which: name, height
and distance, drawn over the camera view.

It is a web app with no install and no build step. It uses the phone's GPS,
compass and tilt sensors to work out where the camera is pointing, then labels
only the peaks that terrain does not hide.

## Using it

The camera, GPS and compass only work on a page served over **https**, so the
app needs to be hosted. The simplest way is GitHub Pages:

1. In the repository on GitHub: **Settings → Pages → Deploy from a branch**.
2. Pick the branch and the `/ (root)` folder, then save.
3. Open the address GitHub shows on your phone and tap **Start scanning**.
   Allow camera, location and motion access when asked.

On iPhone use Safari; on Android use Chrome. "Add to Home Screen" gives it an
app icon and full-screen view.

**Try a sample viewpoint** on the start screen shows a drawn skyline from
Gornergrat in Switzerland, so you can try it at a desk. Drag to look around.

### If the labels are off

Phone compasses are often wrong by 5 to 20 degrees. Tap **Align**: an amber
line shows where the app thinks the skyline is. Drag it onto the real
ridgeline. If peaks line up in the centre but drift towards the edges, adjust
the zoom slider. The correction is remembered.

### Features

- Name, height and distance on each visible peak; metres/km or feet/miles
- Tap a label for direction, height above you, prominence, coordinates and
  links to Wikipedia and a map
- Shutter button saves the view with labels and a caption (position, heading)
- Range of 50, 100 or 200 km
- Areas you have visited are saved on the phone and reused without signal
- Settings → Viewpoint lets you preview any coordinates

## How it works

| Part | File | Notes |
| --- | --- | --- |
| Peak names | `src/peaks.js` | OpenStreetMap via the Overpass API. All named summits within 50 km; beyond that only those with a Wikidata entry. The nearest 25 km load first. |
| Terrain | `src/dem.js` | Terrarium elevation tiles (Mapzen, AWS Open Data). Fine grid near you, coarser grid out to the range. |
| Sightlines | `src/visibility.js` | Walks the terrain between you and each summit, allowing for earth curvature and refraction. Also computes the skyline in every direction. |
| Sensors | `src/sensors.js` | Compass heading, pitch and roll, GPS, camera. |
| Drawing | `src/render.js` | Canvas overlay, label placement, compass strip. |
| Maths | `src/geo.js` | Great-circle, Mercator and camera projection. |

Saved data lives in the browser's Cache Storage; the app shell is cached by
`sw.js`.

## Development

```sh
npm start   # serves on http://localhost:8080 (localhost counts as secure)
npm test    # unit tests for the maths, sightlines and data parsing
```

## Known limits

- Terrain tiles smooth sharp summits by 100 to 200 m, so a peak just peeking
  over a nearer ridge can be wrongly kept or dropped.
- Buildings and trees are not in the terrain data.
- The camera's field of view is assumed (66° on the long side) because
  browsers do not report it; the zoom slider corrects it per phone.
- Works in portrait.

Peak data © OpenStreetMap contributors (ODbL).
