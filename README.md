# Cesium pattern materials

A small CesiumJS + Vite app for developing two custom `Cesium.Material`s:

- **PolylinePatternMaterial** repeats an image stamp along a polyline. The test stamp is a line
  with an "X" on it (`public/patterns/x-stamp.svg`).
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
- The **Line width** and **Stamp spacing** sliders and the **At vertices** combobox change every
  polyline live.
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
public/patterns/                         x-stamp.svg (256x128), hatch-45.svg (256x256)
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

**The image is one stamp.** It's drawn undistorted and as tall as the line is wide, so its
on-screen length is:

```
stamp length = line width × image width / image height
```

The shader works this out itself. It reads the line width from Cesium's `v_width` varying
(which `GroundPolylinePrimitive` provides when the material declares it) and the aspect ratio
from `textureSize(image, 0)`, so there's nothing to configure and no way to distort the
symbol. The image's resolution only affects sharpness, not size.

**Spacing.** There are two ways to space stamps further apart:
- pad the image, for example with plain line on both sides of the symbol, so one repeat
  already includes its gap;
- raise the optional `spacing` multiplier (`create({ spacing })` or
  `material.uniforms.spacing`). Stamps then repeat every `stamp length × spacing`, and the
  extra room is filled with the image's edge column, so the symbol itself is never stretched.

`spacing` can also go **below 1**, down to 0.25, to pack stamps closer than their own length.
Overlapping stamps can then cover the same pixel. Each pixel draws its nearest stamp, then
layers any neighboring stamps (up to two on each side) that also cover it on top, using normal
alpha "over" compositing. At 1× and above no neighbor ever covers a pixel, so this costs nothing
visible there.

The demo's **Stamp spacing** slider is logarithmic, 0.25×–4× with 1× in the middle.

**Stamp size on screen.** `metersPerPixel` comes from `czm_metersPerPixel(eyeCoordinate)`,
which gives meters per CSS pixel; it already includes the pixel ratio, the same units as
`v_width`. The eye coordinate is rebuilt from Cesium's globe depth texture, which is how
`GroundPolylinePrimitive` sizes its own width. As a result:
- Top-down, a stamp is exactly `stamp length × line width` pixels at any zoom.
- When the camera tilts, the stamp foreshortens together with the draped line, like paint on
  the ground.

Screen-space derivatives of `d` would be the more obvious way to get pixel size. They're
avoided because `d` is reconstructed from depth, and differencing neighboring pixels amplifies
the depth noise.

**Placing the stamp image.** The spacing level is chosen from the repeat length
(`stamp length × spacing`), so stamps sit 1–2 repeat lengths apart. For each fragment the shader:
1. finds the nearest stamp center: `index = floor(d / stampSpacing + 0.5)`;
2. converts the offset from that center to pixels and maps it to the image's u coordinate:
   `u = 0.5 + offsetPixels / stampPixels`, with `v = st.t`;
3. lets the gaps between stamps sample the image's edge column, using a `CLAMP_TO_EDGE` sampler.
   For a "line with a symbol" stamp that edge column is the plain line, so the line stays
   continuous between X's while only the X's are spaced out.

**Fade.** Odd-indexed stamps get `1 - smoothstep(0.5, 1.0, fraction toward the next level)`, as
described above.

**Vertices and corners.** A stamp drawn across a vertex is torn in two, because the line changes
direction there. In the mitered wedge on the outside of a corner, Cesium clamps `st.s` to the
vertex, so every wedge pixel reads the same image column and smears it into a stray bracket. The
wedge is therefore always drawn with the plain edge column. It's detected by `st.s` not changing
between neighboring pixels, or, zoomed in close, by the pixel falling outside its segment.

What happens near vertices is a material option, `vertexMode`, set with
`PolylinePatternMaterial.VertexMode`. The demo's **At vertices** combobox switches it live:

| mode | behaviour | trade-off |
|---|---|---|
| `SKIP` (default) | Stamps stay on the global grid; any stamp that would overlap a vertex or line end is left out. | The gap at a vertex depends on where the grid falls, up to about one spacing. |
| `CLIP` | Stamps run right up to the vertex and are cut off there: a pixel only draws stamps centred in its own segment. | A partial stamp, e.g. half an X, can sit at a corner or end. |
| `SNAP` | Stamps sit at the evenly divided points `i / n` of each segment, with `n` a power of two so zoom levels nest without popping. | The gap at a vertex equals the interior spacing, so it's regular but not tighter. |
| `FIT` | Per segment, the first and last stamp touch the vertices, with the rest evenly spaced. | Stamps shift slightly while zooming, because their ground length changes with zoom. |
| `CORNER` | `SKIP`, plus the stamp's symbol (without its own line) drawn centred on every interior vertex, aligned with the corner's mean direction. | Needs per-frame corner data. On a 90° corner the X's arms run close to the lines. |

All modes run through one stamp loop: the nearest stamp plus up to two neighbors on each side,
which also handles overlapping spacings below 1. `SNAP` and `FIT` only change where the stamp
centres are, per segment.

`CORNER` gets a frame for each vertex (position plus two ground axes, in eye coordinates) from a
small float texture that the CPU refreshes every frame. When zoomed in close, it uses uniforms
for the corner nearest the camera instead.

- **Where the vertex distances come from:** a small float texture holding each vertex's
  distance along the line, searched with a binary search in the shader, so there's no vertex
  limit.
- **Close zoom:** the reference points also carry their segment's end distances, in full
  precision.

**Mip level.** `u` jumps from stamp to stamp, which would break the GPU's automatic mip
selection, so the shader samples with `textureLod` and an explicit level:
`log2(imageWidth / (stampPixels × czm_pixelRatio))`, where the multiplication converts CSS
pixels to device pixels.

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
  - The renderer loads and decodes both images once at startup and gives every material the same
    decoded `HTMLImageElement`.
  - Until the real texture is bound, Material uses a 1×1 white placeholder. Both shaders
    `discard` while `textureSize(image, 0).x <= 1`, so a new shape never flashes as a solid block.
- **Per-frame updates.** The renderer's `scene.preRender` listener calls `updateCamera` on every
  material. The polygon needs the camera frame and sphere; the polyline needs its reference
  points.
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

10. **Testing pitfalls.**
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
- **Corners.** The polyline's close-zoom path follows the two segments nearest the camera.
- **Private API.** `mipmapTexture.js` uses a private Cesium field.

## Adding a solution

1. Create `src/solutions/<name>/renderer.js` exporting `createRenderer(viewer)`. It can be
   `async`, and it returns `{ update(shape), remove(shape), destroy() }`. Each `shape` has
   `{ id, type: "polyline" | "polygon", positions, complete }`.
2. Register the solution in `src/solutions/index.js` with an `id`, `label` and `description`.
   It then appears in the Shader dropdown, and switching re-renders the existing shapes with it.
