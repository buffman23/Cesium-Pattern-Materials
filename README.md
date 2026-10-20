# Cesium pattern materials

A small CesiumJS + Vite app for developing two custom `Cesium.Material`s:

- **PolylinePatternMaterial** draws a patterned line with optional symbols on top. It takes two
  optional images: a **line image**, one seamless period of the line (solid, dashed, wave,
  sawtooth …), and a **stamp image**, a symbol such as an "X" or an arrow.
- **PolygonPatternMaterial** fills a polygon with a repeating image tile. The test tile is a
  seamless 45° hatch (`public/patterns/hatch-45.svg`).

Both patterns are **anchored to the ground**, so they don't slide when the camera moves. They also
keep a **near-constant size on screen at any zoom**, from orbit down to Cesium's 1 m minimum
zoom distance.

## Running

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/
```

No Cesium Ion token is needed. The globe uses the offline Natural Earth imagery bundled with
Cesium and no terrain, so the ground is the WGS84 ellipsoid.

**Using the app**
- Click **Draw Polyline** or **Draw Polygon**, then click to place vertices.
- Double-click or right-click to finish the shape.
- Drag the white handles to edit; the pattern updates live.
- These controls change every polyline live:
  - the **Line width** and **Stamp spacing** sliders;
  - the **Line image** and **Stamp image** comboboxes, where "None" removes that layer;
  - the **Stamps at vertices** combobox.
- The toolbar shows the current camera height.
- To share an exact view, run `app.exportState()` in the browser console; it copies the shapes,
  camera, sliders and shader as JSON. `app.importState(json)` recreates that view.
- The **Shader** dropdown selects an implementation. New rendering algorithms are added as new
  entries; see [Adding a solution](#adding-a-solution).

A step-by-step rebuild plan for the materials is in
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Project layout

```
index.html, src/main.js, src/style.css   Viewer, toolbar, shader dropdown, sliders, camera height, export/import
src/tools/DrawTool.js                    Click-to-draw and drag-to-edit tool (renders nothing itself)
src/solutions/index.js                   List of selectable implementations
src/solutions/worldSpace/
  renderer.js                            Builds the Cesium primitives for each drawn shape
  PolylinePatternMaterial.js             Polyline material: GLSL shader (GPU) + per-frame JS uniform updates (CPU)
  PolygonPatternMaterial.js              Polygon material: GLSL shader (GPU) + per-frame JS uniform updates (CPU)
src/shared/
  mipmapTexture.js                       Adds mipmaps and a sampler to a material's image texture
  testPatterns.js                        Test images, colors, line width and tile size
public/patterns/                         Line images: line-solid/-dashed/-wave/-sawtooth.svg
                                         Stamp images: x-symbol.svg, arrow-symbol.svg (256x128)
                                         Polygon tile: hatch-45.svg (256x256)
vite.config.js                           Copies Cesium's static assets (official cesium-vite setup)
```

`DrawTool` handles input only. When a shape's positions change, it calls the selected
solution's renderer, which creates or updates the primitives.

---

## The core idea: power-of-two spacing in meters

A pattern can't be both anchored to the ground and exactly the same pixel size at every zoom.
If the spacing were a fixed number of meters, the stamps would crowd together when you zoom out
and spread apart when you zoom in. If it were a fixed number of pixels, the stamps would slide
along the ground as the view changes.

Both materials resolve this the same way:

1. **Measure pixel size at the fragment.** Compute `metersPerPixel`, how many meters of ground
   one screen pixel covers at this fragment.
2. **Choose a spacing that is a power of two in meters.** With a desired on-screen size of `P`
   pixels:

   ```
   level   = log2(P * metersPerPixel)   // 2^level meters is exactly P pixels on screen
   k       = ceil(level)                // or floor(level) for the polygon; see below
   spacing = 2^k meters                 // between 1x and 2x P pixels on screen
   ```

   Stamps and tiles sit at whole multiples of `spacing`, measured in meters along the line or
   across the ground. That pins them to the world.
3. **Switch levels without popping.** Going from level `k` to `k+1` doubles the spacing. Every
   stamp at the coarser level is also a stamp at the finer level, so only every second stamp
   disappears and the rest stay where they are. That second stamp is faded out smoothly as the
   level approaches the switch point, so nothing jumps.

   ```
   level k   :  X   X   X   X   X   X   X     spacing 2^k
   level k+1 :  X       X       X       X     spacing 2^(k+1); the odd stamps faded out
   ```

So the pattern is always evenly spaced, between 1× and 2× the desired size on screen, and it
never slides relative to the ground.

---

## PolylinePatternMaterial

**Primitive:** `GroundPolylinePrimitive` with a `GroundPolylineGeometry` (geodesic arcs) and a
`PolylineMaterialAppearance`.

- The line is drawn as a shadow volume draped on the globe, so it follows the Earth's curvature
  and never cuts through it.
- The fragment shader gives the material `st.s`, the arc length along the whole line normalized
  to 0..1, and `st.t`, the position across the line width from 0 to 1.

**Distance along the line.** `d = st.s * lineLength` gives meters along the line. `lineLength`
is the geodesic length from `EllipsoidGeodesic`, which matches what Cesium normalizes `st.s` by.

**Two optional layers.**

```js
PolylinePatternMaterial.create({
  lineImage,          // one seamless period of the line; null = no line
  stampImage,         // a symbol on a transparent background; null = no stamps
  lineColor, stampColor,
  spacing: 1,         // stamp repeat as a multiple of the stamp length (0.25-4)
  vertexMode: PolylinePatternMaterial.VertexMode.CLIP,
});
PolylinePatternMaterial.setImages(material, { lineImage, stampImage });   // change later
```

Splitting the line and the symbol solves a conflict. The continuous line must stop exactly at
the geometry, while a symbol must keep one orientation even where it reaches past a corner.
With a single image, those two needs fought each other at every vertex.

**Size: each image is as tall as the line is wide.** Both images keep their aspect ratio, so one
image covers `line width × image width / image height` pixels along the line. The shader works
this out from Cesium's `v_width` varying (which `GroundPolylinePrimitive` provides when the
material declares it) and from `textureSize`. Nothing else configures size, so a symbol can't be
distorted, and an image's resolution only affects its sharpness.

`metersPerPixel` comes from `czm_metersPerPixel(eyeCoordinate)`. It gives meters per CSS pixel
(it already includes the pixel ratio), which is the same unit as `v_width`. The eye coordinate
is rebuilt from Cesium's globe depth texture, which is how `GroundPolylinePrimitive` sizes its
own width. Screen-space derivatives of `d` are avoided: `d` comes from depth, and differencing
neighboring pixels amplifies the noise. As a result:
- seen top-down, sizes are exact at any zoom;
- when the camera tilts, everything foreshortens with the draped line, like paint on the ground.

**Line layer.** The line image is repeated along each segment, fitted so the segment holds a
power-of-two number of whole periods. The pattern therefore starts and ends on a period boundary
at every vertex: dashes, waves and teeth are never cut mid-shape. The pattern stays anchored to
the ground. As you zoom, the period stretches 1×–2×, and just before the count doubles the two
counts cross-fade briefly. The image must be seamless, with matching left and right edges, and
the shader samples it with `fract(phase)` and a REPEAT sampler.

In the mitered wedge outside a corner, Cesium clamps `st.s` to the vertex. The wedge therefore
shows the image's edge column: the profile the line arrives with, extended until the two
segments' profiles meet at the miter. For a solid line that's a clean miter join, and for a
wave or sawtooth it's the miter of its edge profile.

**Stamp layer.** Stamps are drawn on top at a near-constant pixel size, anchored to the line.
The spacing level comes from the repeat length, `stamp length × spacing`, so stamps sit 1–2
repeat lengths apart. Odd-indexed stamps fade out as the level approaches the next power of two.

- **`spacing`** defaults to 1 (stamps touching). Above 1 it shows more of the line between
  stamps. Below 1, down to 0.25, stamps overlap, so each pixel layers its nearest stamp plus up
  to two neighbors on each side (alpha "over" compositing).
- **Each stamp belongs to the segment containing its centre** and is drawn in that segment's
  direction, even where it reaches past a vertex.
- **Overflow past a vertex.** Near an interior vertex, each pixel also draws the stamps of the
  other segment meeting there. It measures its position in that segment's frame, using per-vertex
  frames: eye-space position, incoming and outgoing direction, and up. The CPU computes these in
  double precision and uploads them every frame as a small float texture. Pixels in the corner
  wedge draw both segments' stamps this way, because their `st.s` is clamped. A stamp on a corner
  is therefore whole and has a single orientation, never torn. It's only visible inside the
  line's footprint (the draped bands plus the wedges), so symbols should be no taller than the
  line width.
- **The wedge** is detected by `st.s` not changing between neighboring pixels. When zoomed in
  close, it's detected by the pixel falling outside its segment.

**Stamps at vertices** (`vertexMode`, `PolylinePatternMaterial.VertexMode`; the demo's
**Stamps at vertices** combobox):

| mode | behaviour | trade-off |
|---|---|---|
| `SKIP` | Global grid. Stamps that would reach past a vertex or line end are left out. | The gap at a vertex depends on where the grid falls. |
| `CLIP` (default) | Global grid. Stamps near a vertex are kept and reach past it (drawn whole by the overflow pass), except at the line's two ends, where nothing exists beyond to draw on. | A stamp may sit over a corner, pointing along its own segment. |
| `SNAP` | Stamps at the evenly divided points `i / n` of each segment, with `n` a power of two so zoom levels nest. | The gap at a vertex equals the interior spacing. |
| `FIT` | Per segment, the first and last stamp touch the vertices. | Stamps shift slightly while zooming, because their ground length changes with zoom. |
| `CORNER` | `SKIP`, plus one stamp centred on each interior vertex along the corner's mean direction. | On a 90° corner an X looks rotated 45°. |

Vertex distances come from a small float texture, searched with a binary search, so there's no
vertex limit. Zoomed in close, the shader instead uses the reference points' segment ranges
plus uniforms for the vertex nearest the camera, all in full precision.

**Mip levels.** Stamp `u` jumps between stamps and the line phase wraps, which would break
automatic mip selection. Both layers therefore use `textureLod` with an explicit level:
`log2(imageWidth / (on-screen length × czm_pixelRatio))`, where multiplying by the pixel ratio
converts CSS pixels to device pixels.

**Close-zoom precision.** `st.s` is a float32 fraction of the whole line, so `d` only resolves
to `lineLength × 2⁻²⁴`. That is 22 cm on a 3,600 km line, which is hundreds of pixels at 1 m
zoom. The X's would smear into a bar. When that step size matters
(`metersPerPixel < preciseMetersPerPixel`), the shader measures along the line in eye space
instead:

- **Every frame, on the CPU, in double precision** (`PolylinePatternMaterial.updateCamera`):
  - find the closest point to the camera on the two nearest segments, using a great-circle
    estimate refined on the ellipsoid geodesic (two segments so that corners work);
  - pass each point and its line direction in eye coordinates, which are small numbers;
  - pass each point's distance along the line modulo a power of two (`preciseModulus`) that is
    larger than any spacing used at that zoom, so stamp positions and the odd/even fade stay
    consistent.
- **In the shader:** `d = referenceDistance + dot(fragment - referencePoint, tangent)`, using
  whichever reference line the fragment is closest to.

Where the switch happens, both methods agree to well under a pixel.

## PolygonPatternMaterial

**Primitive:** `GroundPrimitive` with a `PolygonGeometry` and a flat `MaterialAppearance`. The
fill is draped on the globe.

**Ground coordinates.** The material doesn't use the geometry's `st` texture coordinates.
Instead it works in an east/north/up frame at the polygon's center (`setOrigin`) and maps each
fragment to east/north meters `p`. That anchors the pattern to the ground with square tiles,
and the hatch runs at 45° relative to east and north.

**Ray-sphere intersection instead of depth.** On a ground primitive, the fragment position is
reconstructed from the depth buffer. That's too coarse for a fine pattern; the hatch broke
into blocks and streaks that averaged into a flat fill. The shader therefore takes only the
view-ray *direction* from that position and intersects the ray with a sphere:

- The sphere touches the ellipsoid **directly below the camera** and is refit every frame, using
  the Gaussian radius of curvature there.
- Fitting it at the polygon's center instead puts it tens of meters below the real surface far
  from the center. The pattern then lags the camera, almost as if it were fixed to the screen.

The intersection uses a form that avoids cancellation:

```
t² + 2bt + c = 0,   b = (R + h) · dot(up, dir),   c = h (h + 2R)
t = c / (-b + sqrt(b² - c))
```

`h` (the camera's height above the sphere) and `up` (the unit vector from the sphere's center to
the camera) are computed on the CPU in double precision.

**Large polygons.** The camera can be about 1,000 km from the polygon's origin, which float32
only resolves to about 6 cm. The camera's east/north position is therefore split into float
`high + low` parts:

- The shader works with `low + t·dir`, which is small and precise.
- It wraps `high` by the tile size with `mod(high, size)`. That is exact in float, because the
  tile size is a power of two.

**Tile size and cross-fade.**
- `metersPerPixel` comes from the distance along the ray: `czm_metersPerPixel(dir · t)`.
- `level = log2(tileSize × metersPerPixel)`, then `k = floor(level)`.
- The shader samples tiles of `2^k` and `2^(k+1)` meters and blends them by `level - k`, so the
  tile is about `tileSize` pixels on screen at any zoom.
- `textureGrad` with the smooth derivatives of `p` picks the right mip level, including
  anisotropy when the camera is tilted.

**Seamless test tile.** `hatch-45.svg` contains:
- the main diagonal, plus the two half-diagonals in opposite corners, so the lines continue
  exactly across tile edges;
- lines drawn past the tile bounds, so their end caps never show.

Doubling the tile size keeps every other line in the same place, so blending between the two
levels just fades the in-between lines.

## Shared details

- **Mipmaps** (`src/shared/mipmapTexture.js`). Cesium's Material uploads images without
  mipmaps, so a detailed tile drawn small shimmers and shows bands. This helper wraps the
  material's `update`: once the image texture exists, it generates mipmaps and sets a trilinear
  sampler with the requested wrap modes. It relies on the private `Material._textures`, so
  revisit it after Cesium upgrades.
- **Un-premultiply.** Browsers rasterize transparent SVG/PNG pixels as black. Texture filtering
  blends that black into stroke edges, so both shaders compute `rgb /= a` to remove the dark
  fringe.
- **No flash while loading.**
  - The renderer loads and decodes every image once at startup and gives each material the same
    decoded `HTMLImageElement`s.
  - Until the real texture is bound, Material uses a 1×1 white placeholder. The shaders treat a
    1×1 texture as "no image": the polygon draws nothing, and the polyline skips that layer.
    That's also how a `null` line or stamp image works. A new shape therefore never flashes as a
    solid block.
- **Per-frame updates.** The renderer's `scene.preRender` listener calls `updateCamera` on every
  material:
  - the polygon needs the camera frame and sphere;
  - the polyline needs its reference points and vertex frames.
- **Dependency pin.** `package.json` overrides `@zip.js/zip.js` to 2.7.52, because newer
  versions break Cesium 1.122's imports when Vite pre-bundles dependencies.

## Hurdles along the way

Roughly in the order they came up. Each explains why the code looks the way it does.

1. **Cesium and Vite dependency break.** The dev server failed to start because Vite couldn't
   pre-bundle Cesium 1.122: a newer `@zip.js/zip.js` had removed a file Cesium imports. Fixed
   by pinning `@zip.js/zip.js` to 2.7.52.

2. **Dark fringes around strokes.** Browsers decode transparent SVG pixels as black, and texture
   filtering blended that black into the edges of the X's and hatch lines. Fixed by
   un-premultiplying in the shaders (`rgb /= a`).

3. **Moiré bands in the hatch.** A 256 px tile drawn at about 12 px aliases badly, because
   Cesium's Material never creates mipmaps. `mipmapTexture.js` adds them. Mipmaps then caused
   seams wherever the shader wrapped coordinates with `fract()`, because mip selection broke at
   each wrap. The fix was to:
   - tile with the REPEAT wrap mode instead of `fract()`;
   - use `textureGrad` or `textureLod` with explicit gradients or an explicit mip level wherever
     coordinates still jump (between stamps).

4. **The first version was screen-space, and it fell short.** The X's were placed from
   `gl_FragCoord` on a `PolylineCollection`, and the hatch used fixed 200 m tiles. Testing
   showed three problems:
   - The X's slid along the line when panning, because they were fixed to the screen.
   - Polylines were straight chords between vertices and cut through the globe on long lines.
   - Zoomed out, a 200 m tile shrank below one pixel and the hatch averaged into a solid fill.

   This led to the ground-clamped primitives and the power-of-two spacing scheme. The
   screen-space version was kept as a dropdown option for comparison for a while, then removed.

5. **Material doesn't accept `Matrix4` uniforms.** Passing a `Matrix4` threw "uniform has
   invalid type". Material only recognizes matrices given as plain 16-number arrays, so the
   matrix is packed into one with `Matrix4.pack`.

6. **Speckled, broken X's at long range.** Pixel size was first taken from screen-space
   derivatives of the distance along the line. On ground polylines that distance comes from
   the depth buffer, and differencing neighboring pixels amplified the depth noise. Switched to
   `czm_metersPerPixel` at the fragment's depth, which is also how Cesium sizes the line width,
   so X proportions match the line.

7. **The hatch rendered as solid blue.** Software rendering looked fine, but on a real GPU with
   large polygons or tilted views the hatch broke into blocks and streaks that averaged into a
   flat fill. The cause was the fragment position rebuilt from the depth buffer, which is too
   coarse for a fine pattern. The shader now intersects the view ray with a sphere and keeps
   only the ray's direction from the depth-based position.

8. **Glitches near max zoom.** A zoom sweep down to 1 m found:
   - **Fill vanishing up close.** The screen-space version's flat polygon triangles, tens of
     kilometers across, sagged meters below the curved ground, and the globe covered them.
     Draping the fill fixed it.
   - **The hatch stuck to the screen on large polygons.** Two causes:
     - The sphere was fitted at the polygon's center, about 50 m below the real surface
       1,000 km away, so the pattern was effectively projected 50 m underground and lagged the
       camera through parallax. Fixed by refitting the sphere below the camera every frame.
     - float32 could only hold the camera's 1,000 km offset to about 6 cm. Fixed by splitting
       it into `high + low` parts and computing camera-relative values in double precision on
       the CPU.
   - **X's smearing into a bar on long lines.** `st.s` resolves to only 22 cm on a 3,600 km
     line. The natural fix, reading Cesium's per-segment varyings in the material, isn't
     possible: the material source is inserted before those varyings are declared, and GLSL
     forbids declaring them twice. Splitting the line into about 16 km chunks would have meant
     hundreds of primitives and materials. Instead, the CPU computes reference points near the
     camera each frame, as described above.

9. **A solid rectangle flashed when starting a line.** Each new shape's material loaded the SVG
   itself, and until it arrived Cesium bound a 1×1 white placeholder that the shader drew as
   solid. Fixed by decoding the images once and sharing them, and by discarding fragments while
   the placeholder is bound.

10. **Corners: from skipping, to five modes, to two images.** An X on a vertex was torn in two,
    with the halves pointing along different segments, and the mitered wedge smeared one image
    column into a bracket. The steps along the way:
    - **Skip:** stamps across vertices were simply left out.
    - **Vertex modes:** clip, snap, fit and corner were added as options. Clipping still tore the
      X near the vertex, because the line's two segments split the corner diagonally.
    - **Two images:** the root cause was that one image held both the line, which must stop at
      the geometry, and the symbol, which must keep one orientation. So the line and the symbol
      became separate images. The line is bounded per segment, and the symbol is drawn whole in
      its own segment's frame, from per-vertex frames, wherever it reaches.
    - **Rejected along the way:** stretching one copy of the line per segment, which distorts
      with segment length; and subtracting a stamp's line to isolate its symbol.

11. **Testing pitfalls.**
    - Headless Chrome's software renderer, SwiftShader, didn't show the precision bugs. Tests
      had to run on the real GPU (`--use-angle=d3d11`).
    - At 1 m the view covers only about a meter, so the test camera had to aim at the true
      geodesic point. Aiming at the average of the endpoints' longitude and latitude missed
      the line, and that once looked like a rendering bug.
    - Still screenshots hid the "stuck to the screen" bug. Catching it took stepping the camera
      1 cm at a time and checking that the pattern moved the same number of pixels as the ground.

## Known trade-offs

- **Spacing range.** Spacing and tile size vary between 1× and 2× the target as you zoom.
  During a level change you'll see half-faded X's, or thick and thin hatch lines together. This
  is the price of being anchored to the ground and never popping.
- **Tilted views.** The line, X's and hatch foreshorten when the camera is tilted, like paint on
  the ground. To keep the X's full size when tilted, you'd need a camera-facing line, which
  would be a different algorithm and a new dropdown entry.
- **Terrain.** The polygon's sphere intersection assumes the ground is the ellipsoid. With
  terrain, the hatch would shift slightly with parallax over hills.
- **Line period.** A line image's period stretches 1×–2× as you zoom. Near a doubling, the two
  period counts briefly cross-fade, so waves show a faint double image for a short zoom range.
- **Symbol size.** Stamps (and the overflow past a vertex) only show inside the line's footprint,
  so a symbol taller than the line width is clipped.
- **Close zoom near several corners.** The close-zoom path follows the two segments, and the
  vertex, nearest the camera.
- **Private API.** `mipmapTexture.js` uses a private Cesium field.

## Adding a solution

1. Create `src/solutions/<name>/renderer.js` exporting `createRenderer(viewer)`. It can be
   `async`, and it returns `{ update(shape), remove(shape), destroy() }`. Each `shape` has
   `{ id, type: "polyline" | "polygon", positions, complete }`.
2. Register the solution in `src/solutions/index.js` with an `id`, `label` and `description`.
   It then appears in the Shader dropdown, and switching re-renders the existing shapes with it.
