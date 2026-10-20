# Cesium pattern materials

A small CesiumJS + Vite app for developing two custom `Cesium.Material`s:

- **PolylinePatternMaterial** draws a patterned line with optional symbols on top. It takes two
  optional images: a **line image**, one seamless period of the line (solid, dashed, wave,
  sawtooth …), and a **stamp image**, a symbol such as an "X" or an arrow.
- **PolygonPatternMaterial** fills a polygon with a repeating image tile. The test tile is a
  seamless 45° hatch (`public/patterns/hatch-45.svg`).

Both patterns are **anchored to the ground**, so they don't slide when the camera moves. They also
keep a **near-constant size on screen at any zoom**, from orbit down to Cesium's 1 m minimum
zoom distance, and both drape over the globe.

## Running

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/
```

No Cesium Ion token is needed. The globe uses the offline Natural Earth imagery bundled with
Cesium and no terrain, so the ground is the WGS84 ellipsoid.

## Using the app

- Click **Draw Polyline** or **Draw Polygon**, then click to place vertices. Double-click or
  right-click to finish the shape, and drag the white handles to edit it.
- **Line width** and **Stamp spacing** sliders, and **Line image** / **Stamp image** comboboxes
  ("None" removes that layer), change every polyline live.
- **Max height** stops patterns from rescaling once you zoom out far enough: above it they keep
  their ground size and shrink like paint on the ground. It is set per shape, in multiples of
  the camera height at which the shape fills the view (1× = the whole shape is in view). The
  dark handle is the max height, the light handle where a smooth transition into it starts,
  and the far right end means off.
- In the browser console, `app.exportState()` copies the shapes, camera and settings as JSON,
  and `app.importState(json)` recreates that view.

## Using the materials

```js
import PolylinePatternMaterial from "./src/solutions/worldSpace/PolylinePatternMaterial.js";
import PolygonPatternMaterial from "./src/solutions/worldSpace/PolygonPatternMaterial.js";

// Polyline: render with GroundPolylinePrimitive + GroundPolylineGeometry + PolylineMaterialAppearance.
const lineMaterial = PolylinePatternMaterial.create({
  lineImage, stampImage,   // images or URLs; null = no line / no stamps
  lineColor, stampColor,
  spacing: 1,              // stamp repeat as a multiple of the stamp length (0.25-4)
  maxHeight: Infinity,     // optional: camera height (m) above which the pattern keeps its ground size
  heightTransition: 0,     // optional: meters below maxHeight over which that eases in
});
PolylinePatternMaterial.setPositions(lineMaterial, positions, lineWidthPixels);

// Polygon: render with GroundPrimitive + PolygonGeometry + MaterialAppearance.
const fillMaterial = PolygonPatternMaterial.create({ image, color, tileSize: 48 });
PolygonPatternMaterial.setOrigin(fillMaterial, positions);

// Every frame (e.g. from scene.preRender):
PolylinePatternMaterial.updateCamera(lineMaterial, scene);
PolygonPatternMaterial.updateCamera(fillMaterial, scene);
```

`src/solutions/worldSpace/renderer.js` shows the full setup, including the primitives.

## How it works

Pattern spacing is a **power of two in meters**, chosen per pixel so that it is 1×–2× the
desired on-screen size. Stamps and tiles sit at whole multiples of it, which pins them to the
ground. When the zoom crosses a power of two, the spacing doubles: every second stamp (or the
finer tile) fades out briefly instead of popping, and once the camera stops the fade settles so
nothing stays half faded. Close-zoom precision is handled with camera-relative values computed
on the CPU in double precision.

The details, including corners, precision, the development history and the known trade-offs,
are in [`docs/TECHNICAL_NOTES.md`](docs/TECHNICAL_NOTES.md).

**Limitations:** patterns foreshorten in tilted views like paint on the ground; the ground is
assumed to be the ellipsoid (no terrain); stamps taller than the line width are clipped; and
`src/shared/mipmapTexture.js` relies on private Cesium fields.

## Project layout

```
index.html, src/main.js, src/style.css   Viewer, toolbar, sliders, camera height, export/import
src/tools/DrawTool.js                    Click-to-draw and drag-to-edit tool (renders nothing itself)
src/solutions/worldSpace/
  renderer.js                            Builds the Cesium primitives for each drawn shape
  PolylinePatternMaterial.js             Polyline material: GLSL shader + per-frame CPU updates
  PolygonPatternMaterial.js              Polygon material: GLSL shader + per-frame CPU updates
src/shared/
  mipmapTexture.js                       Adds mipmaps and a sampler to a material's image texture
  zoomSettle.js                          Keeps zoom cross-fades from resting half faded
  maxHeight.js                           Max camera height soft cap, fitted to a shape
  testPatterns.js                        Test images, colors, line width and tile size
public/patterns/                         Line, stamp and hatch test images (SVG)
docs/                                    Technical notes and a step-by-step rebuild plan
```
