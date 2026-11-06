# Cesium pattern materials

A small CesiumJS + Vite app for developing two custom `Cesium.Material`s:

- **PolylinePatternMaterial** draws a patterned line with optional symbols on top. It takes two
  optional images: a **line image**, one seamless period of the line (solid, dashed, wave,
  sawtooth …), and a **stamp image**, a symbol such as an "X" or an arrow.
- **PolygonPatternMaterial** fills a polygon with a repeating image tile. The test tiles are a
  seamless 45° hatch, dots and a checkerboard (`public/patterns/hatch-45.svg`, `dots.svg`,
  `checkers.svg`), chosen with the "Polygon fill" select.

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

## Shape library (`src/shapes/`)

A separate demo at **`/shapes.html`** (`src/shapesDemo.js`) shows a reusable drawing and
editing library. It has a `Shape` base class and these subclasses: `Polyline`, `Polygon`,
`Corridor` (all three extend `VertexShape`), `Circle`, `Rectangle`, `Sector` and `Box`.

```js
import { ShapeEditor, Polygon, Circle, patternFillMaterial } from "./src/shapes/index.js";

const editor = await ShapeEditor.create(viewer);          // one per viewer
editor.startDrawing(Polygon, {
  arcType: ArcType.RHUMB,                                  // or GEODESIC (default)
  outline: { material: Color.YELLOW, width: 3 },           // Color, Cesium Material or spec
  fill: { material: patternFillMaterial({ image, color }) },
  markers: { numbered: true, deletable: true },            // see DEFAULT_MARKER_OPTIONS
  clampToGround: false, height: 5000,                      // at altitude
});
editor.selected?.toJSON();                                 // Shape.fromJSON(json) restores it
```

- **Corridor:** a chain of cylinders. Each vertex has its own radius and min / max altitude,
  and each leg joins two cylinders with straight tangent sides, so the width tapers.
  `altitudeMode: "slope"` slopes the floor and ceiling between cylinders; `"step"` keeps
  each leg at the lower floor and higher ceiling of its two cylinders. Clamped to the ground
  it shows only the footprint. Markers per vertex: the vertex, a radius arrow, and (at
  altitude) top and bottom arrows dragged up or down. It needs the `polygon-clipping`
  package and must fit within a hemisphere.
- **Box:** a rotatable box with two forms on one geometry. The anchor form takes `anchor1`,
  `anchor2` (the middles of the short ends) and `width`. The center form takes `center`,
  `length`, `width` and `heading`. Each form has its own drawing steps, markers and fields,
  and `setForm` switches between them without moving the box.
- **Modes:** a shape starts in DRAW_MODE. When it is finished it enters EDIT_MODE, where
  markers can be dragged. Clicking empty globe or pressing Esc makes it IDLE, and clicking it
  edits it again.
- **Markers:** white squares by default; the image can be changed. Vertex markers can be
  deletable (a red X shows on hover or click) or numbered pins (PinBuilder). A translate
  marker moves the whole shape. At altitude, shift+drag changes height. Each handle's look
  shows what it does:
  - Point handles are white squares.
  - Circle and Corridor resize handles are cyan double arrows that point the way they resize.
  - Box handles are squares: yellow for the width, white for the ends (anchors, or the
    center form's rotate-and-lengthen ends).
  - Sector handles are all white squares.
  - The `roleStyles` marker option changes any of these per role, per shape class
    (`static defaultMarkerOptions`) or per shape.
- **Cursor messages:** while drawing, a small box at the mouse cursor says what to do next,
  such as "Click to set center" or "Click to add vertex". Each shape's `cursorMessages`
  option turns it off (`false`) or supplies your own text (a function). Use the editor's
  `cursorMessage` option to style it, offset it or turn it off everywhere.
- **Forms and binding:** each shape type lists its editable fields in `static fields` (name,
  label, type, limits). `getField` / `setField` read and write them in degrees and meters,
  with validation. `editor.shapeChanged` says which fields changed and whether drawing, a
  drag or code changed them. The demo's right-hand panel is built only from these:

  ```js
  for (const field of shape.fields) console.log(field.label, shape.getField(field.name));
  shape.setField("radius", 25000);           // meters; rebuilds on the next frame
  editor.shapeChanged.addEventListener((shape, { fields, source }) => {
    for (const name of fields) updateInput(name, shape.getField(name)); // source: draw|drag|api
  });
  ```
- **Performance:** a changed shape is rebuilt at most once per frame, and coarser while it is
  being drawn or dragged. A whole shape is one fill primitive plus its outline primitives.
  Only the shape being edited has billboards. Per-frame material updates skip shapes outside
  the view.
- **Materials:** the pattern materials only work on ground-clamped shapes. At altitude they
  fall back to a solid color.
- **Subclassing:** implement `outlineLines()` (any number of lines, each with a material
  key), `createFillGeometry()`, `markerSpecs()` and `onMarkerDrag()`. The class comments in
  `Shape.js` and `VertexShape.js` list every hook.

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
shapes.html, src/shapesDemo.js           Shape library demo
src/shapes/                              Shape classes, ShapeEditor, markers, materials, geodesy
public/patterns/                         Line, stamp and polygon fill test images (SVG)
docs/                                    Technical notes and a step-by-step rebuild plan
```
