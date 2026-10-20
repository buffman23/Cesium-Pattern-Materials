# Implementation plan: ground-anchored pattern materials

This is a step-by-step plan for building five files from scratch:

- `src/shared/mipmapTexture.js`
- `src/shared/zoomSettle.js`
- `src/shared/maxHeight.js`
- `src/solutions/worldSpace/PolylinePatternMaterial.js`
- `src/solutions/worldSpace/PolygonPatternMaterial.js`

Follow the steps in order. Each step lists **what to build**, the **exact formulas or code**
where they matter, and **pitfalls**. Most pitfalls are mistakes that were made and fixed in the
original implementation; the rest are traps the current code is written around. Don't skip them. Background on why the design works is in
`docs/TECHNICAL_NOTES.md`.

---

## 0. Ground rules and context

### Environment

- CesiumJS **1.122** (`import { ... } from "cesium"`), WebGL2, so GLSL ES 3.00
  (`texture`, `textureLod`, `textureGrad`, `texelFetch` and `textureSize` are available).
- Globe: WGS84 ellipsoid, **no terrain**. Always use `Ellipsoid.WGS84`.
- The viewer uses `requestRenderMode: true`, so frames are only drawn on request. Anything that
  animates by itself (image loading, fade settling) must call `scene.requestRender()`.
- Use plain ES modules, 2-space indentation and double quotes, matching the existing files.

### Public API and usage requirements

The materials import only `"cesium"` and the three `src/shared/` helpers; nothing else in the
app. They don't control how they're used, though. The shaders depend on specific Cesium
primitives and on per-frame calls from whatever code uses them. Build the API below exactly,
and document these requirements in each file's comments:

- **PolylinePatternMaterial:**
  - `create({ lineImage, stampImage, lineColor, stampColor, spacing, maxHeight, heightTransition })`
    returns a `Material`. Every option is optional.
    - `lineImage` is **one seamless period** of the line (solid, dashed, wave, sawtooth …); its
      left and right edges must join. `null` (the default) means no line layer.
    - `stampImage` is **one symbol** on a transparent background (an X, an arrow), drawn on top.
      `null` (the default) means no stamps.
    - Neither image's size on screen is configured: each is always drawn as tall as the line is
      wide and `lineWidth × imageWidth / imageHeight` long.
    - `lineColor` and `stampColor` default to `Color.WHITE`.
    - `spacing` defaults to 1 and can be changed later through `material.uniforms.spacing`.
    - `maxHeight` (default `Infinity` = off) and `heightTransition` (default 0) can be changed
      later through `material.maxHeight` and `material.heightTransition`. See Step 3.
  - `setImages(material, { lineImage, stampImage })` swaps either image. `null` removes that
    layer; `undefined` leaves it unchanged.
  - `setPositions(material, positions, width)` must be called whenever the line's positions or
    width change. `width` is the same pixel width given to `GroundPolylineGeometry`.
  - `updateCamera(material, scene)` must be called **every frame**, for example from
    `scene.preRender`. It takes the **scene**, not the camera: it needs the canvas size and
    `requestRender()`.
  - It must be rendered with `GroundPolylinePrimitive` + `GroundPolylineGeometry` +
    `PolylineMaterialAppearance`. The shader relies on three things from that primitive:
    - `st.s` being the normalized arc length along the whole line;
    - the `v_width` varying, the line width in CSS pixels;
    - Cesium's globe depth texture.
- **PolygonPatternMaterial:**
  - `create({ image, color, tileSize, maxHeight, heightTransition })` returns a `Material`.
  - `setOrigin(material, positions)` must be called whenever the polygon's positions change.
  - `updateCamera(material, scene)` must be called **every frame**.
  - It must be rendered with a primitive whose material input provides `positionToEyeEC`, such
    as `GroundPrimitive` + `PolygonGeometry` + a flat, translucent `MaterialAppearance`.
- **Both:** `material.loadingImages` is a `Set` of image uniform names that are set but not on
  the GPU yet (Step 1). While it's non-empty, the caller must keep requesting frames, for
  example from `scene.postRender`.
- Images may be a URL, an `HTMLImageElement` or a canvas. The test images, in
  `public/patterns/`, are:
  | file | size | use |
  |---|---|---|
  | `line-solid.svg` | 64×128 | line |
  | `line-dashed.svg`, `line-sawtooth.svg` | 128×128 | line |
  | `line-wave.svg` | 256×128 | line |
  | `x-symbol.svg`, `arrow-symbol.svg` | 256×128 | stamp |
  | `hatch-45.svg` | 256×256 | polygon tile, seamless 45° hatch |

### Material rules that apply to every file

- **Creating the material:** build it with
  `new Material({ fabric: { type, uniforms, source }, translucent: true })`.
  - `type` must be a unique string.
  - `source` is a GLSL string that defines `czm_material czm_getMaterial(czm_materialInput materialInput)`.
  - Declare every uniform in the GLSL with the **same name** as its key in `uniforms`.
- **Changing uniforms at runtime:** write to `material.uniforms.<name>`.
  - For vector uniforms (`Cartesian2/3/4`), **mutate the existing object in place**, for
    example `uniforms.cameraLow.x = ...`. Material reads it by reference each frame.
- **Uniform types** (Material infers them from the JS value):
  | JS value | GLSL type |
  |---|---|
  | number | `float` |
  | `Color` | `vec4` |
  | `Cartesian2` / `Cartesian3` / `Cartesian4` | `vec2` / `vec3` / `vec4` |
  | image, or `Material.DefaultImageId` | `sampler2D` |
  | `Texture` instance | `sampler2D` (used directly; Material destroys the previous one) |
- **No image:** give a sampler uniform `Material.DefaultImageId`. Material then binds its 1×1
  white placeholder, the same one it binds while an image is loading. The shaders treat any 1×1
  texture as "no image".
- **Matrices:** ⚠️ Material does **not** accept a `Matrix4` instance; it throws "uniform has
  invalid type". Pass a plain 16-number array, `Matrix4.toArray(Matrix4.IDENTITY)`, and
  update it with `Matrix4.pack(matrix, uniforms.eyeToLocal)`.
- **Return value:** each `create()` returns the `Material` after passing it through
  `mipmapTexture(...)`, once per image uniform.

> ⚠️ The GLSL lives in a JavaScript template string, so **never put a backtick in a shader
> comment**. It ends the string and breaks the JS.

### Shader code shared by both materials

**Un-premultiply.** Browsers decode transparent SVG/PNG pixels as black; filtering blends that
black into stroke edges, giving a dark fringe. Every sample is un-premultiplied before it's
tinted:

```glsl
tex.rgb = min(tex.rgb / max(tex.a, 0.0001), 1.0);
```

**Gamma.** The final color goes through `czm_gammaCorrect(fragColor)`, and a fragment with
`alpha < 0.005` is discarded.

**Placeholder.** Until an image loads, Cesium binds a 1×1 white placeholder texture, which
would render as a solid block. Test `textureSize(image, 0).x <= 1` and draw nothing for that
image (the exact form differs per material; see 4.3 and 5.3).

**Pixel size.** `czm_metersPerPixel(eyePosition)` returns meters per **CSS** pixel; it
already includes `czm_pixelRatio`. Line widths and tile sizes are also CSS pixels, so never
multiply sizes by `czm_pixelRatio`. It belongs only in explicit mip levels, which count device
pixels.

---

## Step 1 — `src/shared/mipmapTexture.js`

**Why it's needed:** Cesium's Material uploads images **without mipmaps**. A 256 px tile drawn
at about 12 px then produces moiré bands, and the hatch can look solid. It also turns a loaded
image into a texture only on a *later* `update`, which in request-render mode may never come.

**Build:** a default-exported function
`mipmapTexture(material, uniformName, { wrapS = TextureWrap.REPEAT, wrapT = TextureWrap.REPEAT } = {})`
that returns `material`. It's called once per image uniform on the same material, so each call
chains onto the previous wrapper.

1. Save `const originalUpdate = material.update.bind(material)`. Keep a variable `mipmapped`,
   initially undefined. Initialize `material.loadingImages ??= new Set()` (shared by all calls).
2. Replace `material.update = function (context) { ... }` with a version that:
   - calls `originalUpdate(context)` first;
   - reads `const texture = material._textures[uniformName]` and
     `const value = material.uniforms[uniformName]`. `_textures` is a private Cesium field;
     say so in a comment;
   - sets `hasImage = value !== undefined && value !== null && value !== Material.DefaultImageId`;
   - sets `queued = material._loadedImages.some((loaded) => loaded.id === uniformName)`. This
     private queue holds a decoded image waiting for the next update; meanwhile the old texture
     (or the placeholder) is still bound;
   - if `queued || (hasImage && (!texture || texture === context.defaultTexture))`, adds
     `uniformName` to `material.loadingImages`; otherwise deletes it;
   - returns early if `!texture`, `texture === context.defaultTexture`, or
     `texture === mipmapped` (already done);
   - otherwise calls `texture.generateMipmap()`, then sets
     `texture.sampler = new Sampler({ wrapS, wrapT, minificationFilter: TextureMinificationFilter.LINEAR_MIPMAP_LINEAR, maximumAnisotropy: 8 })`,
     then sets `mipmapped = texture`.
3. Imports: `Material`, `Sampler`, `TextureMinificationFilter` and `TextureWrap` from `"cesium"`.

**Pitfalls:**
- Don't replace the texture yourself, only its sampler.
- Don't call `generateMipmap` every frame. Comparing with `mipmapped` also handles an image
  swap: the new texture is a different object and gets its own mipmaps.
- Count a *queued* image as loading even though a texture is bound. During a swap the old
  texture stays bound until the next update; without this, the new image doesn't appear until
  the camera moves.

---

## Step 2 — `src/shared/zoomSettle.js`

**Why it's needed:** both materials pick a power-of-two scale from the zoom level and cross-fade
between two scales while the level's fractional part is inside a short **fade window**. A
camera that stops inside that window leaves the pattern half faded indefinitely. Once the camera
height stops changing, each layer therefore gets a small **level shift**, the same for every
pixel (so the fade just moves and no seam appears), animated until the screen centre leaves the
window by its nearest edge. While the height is changing, the shift stays put.

Constants: `REST_DELAY_MS = 150` (no height change for this long = at rest), `SPEED = 0.3`
(levels per second), `MARGIN = 0.03` (levels beyond the window edge, so nearby pixels leave it
too).

### 2.1 `referenceMetersPerPixel(scene)` (exported)

Meters per CSS pixel on the ground at the screen centre, measured like `czm_metersPerPixel`.
Cache it per frame in a module-level `{ scene, frame, metersPerPixel }`, keyed by
`scene.frameState.frameNumber`, because every material calls it.

1. `center = (canvas.clientWidth / 2, canvas.clientHeight / 2)`.
2. `ground = camera.pickEllipsoid(center, scene.globe?.ellipsoid)`.
3. `depth = ground ? dot(ground - camera.positionWC, camera.directionWC) : camera.positionCartographic.height`.
   The fallback covers a centre that shows sky.
4. `pixel = camera.frustum.getPixelDimensions(scene.drawingBufferWidth, scene.drawingBufferHeight, max(depth, 1e-3), scene.pixelRatio, scratch)`.
5. Return `max(pixel.y, 1e-9)`.

### 2.2 `createZoomSettle()` (exported)

Returns `{ height: undefined, lastChange: -Infinity, lastFrame: undefined, shifts: {} }`, one
per material.

### 2.3 `updateZoomSettle(state, scene, layers)` (exported)

`layers` is `{ name: { level, window: [start, end] } }`: per layer, the zoom level at the screen
centre, `log2(pattern meters)`, and the range of its fractional part where it's partly faded.
`end` may exceed 1. Returns `state.shifts`, `{ name: shift }`.

1. `now = performance.now()`, `height = scene.camera.positionCartographic.height`. If
   `state.height` is defined and `|height - state.height| > 1e-6 × |height|`, set
   `state.lastChange = now`. Store `state.height = height`.
2. `first = state.lastFrame === undefined`.
   `dt = first ? 0 : min((now - state.lastFrame) / 1000, 0.1)`. The cap matters: frames stop
   while idle, so the gap after a pause can be seconds. Store `state.lastFrame = now`.
3. `resting = now - state.lastChange >= REST_DELAY_MS`. Start `settling = !resting`, so frames
   keep coming until the rest is noticed.
4. For each layer: `shift = state.shifts[name] ?? 0`. If resting,
   `target = settledShift(level, shift, window)`, then
   `shift = first ? target : approach(shift, target, SPEED × dt)`, and
   `settling ||= shift !== target`. Store it.
5. If `settling`, call `scene.requestRender()`.

Helpers:

```js
// Where in the window (0..length) a level lies, or -1 outside it. The window grows by MARGIN.
function windowPosition(level, [start, end]) {
  const length = end - start + 2 * MARGIN;
  const d = level - (start - MARGIN);
  const f = d - Math.floor(d);
  return f > 0 && f < length ? f : -1;
}

// The current shift if it already leaves the level outside the window, otherwise the nearest
// of the unshifted level's exits (so shifts stay below one window).
function settledShift(level, shift, window) {
  if (windowPosition(level + shift, window) < 0) return shift;
  const f = windowPosition(level, window);
  if (f < 0) return 0;
  const length = window[1] - window[0] + 2 * MARGIN;
  const down = -f;
  const up = length - f;
  return Math.abs(down - shift) <= Math.abs(up - shift) ? down : up;
}

function approach(value, target, maxStep) {
  return Math.abs(target - value) <= maxStep ? target : value + Math.sign(target - value) * maxStep;
}
```

**Pitfalls:**
- The shift must be added to the shader's level for **every pixel alike**, as a uniform. A
  per-pixel correction would create a seam.
- Don't move the shift while the camera height is changing. Fades must follow the zoom
  smoothly; only a resting camera is corrected.
- Keep the current shift if it already works (`settledShift`'s first test). Otherwise a small
  zoom would snap the shift back to 0 and make the pattern jump.

---

## Step 3 — `src/shared/maxHeight.js`

**Why it's needed:** patterns keep a near-constant on-screen size by scaling with the camera
height. Above a **max height** they should stop scaling and keep their ground size instead,
shrinking on screen like paint, easing in over a transition below it.

### 3.1 `sizeScale(height, maxHeight, transition)` (exported)

Returns the factor in (0, 1] that the materials multiply their meters-per-pixel by:
`effectiveHeight / height`, with a C¹ soft cap. With `H = maxHeight` and
`T = clamp(transition, 0, H)`:

```
effectiveHeight = h                                  for h <= H - T
                = h - (h - (H - T))^2 / (2 T)        for H - T < h < H  (slope eases 1 -> 0)
                = H - T / 2                          for h >= H         (size frozen)
```

Return 1 if `maxHeight` isn't finite or `!(height > 0)`. Return `min(effective / height, 1)`.
With `T = 0` it's a hard `min(h, H)`.

### 3.2 `boundingBoxDiagonal(positions)` (exported)

Ground length of the diagonal of the positions' longitude/latitude box:
`Rectangle.fromCartesianArray(positions)`, then
`new EllipsoidGeodesic(Rectangle.southwest(box), Rectangle.northeast(box)).surfaceDistance`.
Return 0 for fewer than two positions or an empty box.

### 3.3 `fitMaxHeight(diagonal, camera, factor, easeFrom)` (exported)

The max height for a shape, in units of its **fit height**: the camera height at which the
diagonal just fills the view vertically, looking straight down.

```js
if (!(diagonal > 0) || !Number.isFinite(factor)) return { maxHeight: Infinity, heightTransition: 0 };
const fovy = camera.frustum.fovy ?? Math.PI / 3;
const fitHeight = diagonal / (2 * Math.tan(fovy / 2));
const maxHeight = factor * fitHeight;
const start = Math.min(Math.max(easeFrom, 0), factor) * fitHeight;
return { maxHeight, heightTransition: maxHeight - start };
```

The materials only use `sizeScale`. `boundingBoxDiagonal` and `fitMaxHeight` are for the
caller, which sets `material.maxHeight` and `material.heightTransition` per shape every frame
(it depends on the field of view).

---

## Step 4 — `src/solutions/worldSpace/PolylinePatternMaterial.js`

### 4.1 Behaviour to achieve

Two optional layers, both drawn as tall as the line is wide, so each image keeps its aspect
ratio:

**Line layer.** A seamless pattern repeated along the line, anchored to the ground and to the
line's start.
- The period is `2^k` meters, with `k` chosen per fragment so the period is 1×–2× the image's
  natural length (`lineWidth × imageWidth / imageHeight`). It depends only on zoom, so moving a
  vertex never stretches it.
- Just before the period doubles, the pattern is nearly 2× stretched; it cross-fades to half
  the period there, over `fract(level)` in 0..0.2.
- It runs on across vertices. In the mitered wedge outside a corner, `GroundPolylinePrimitive`
  clamps `st.s` to the vertex, so the wedge shows the image column at the vertex. For a solid
  line that's a clean miter join.

**Stamp layer.** Symbols drawn on top at a near-constant pixel size, anchored to the line.
- The repeat length is `stamp length × spacing`. `spacing` defaults to 1 (touching) and is
  clamped to ≥ `MIN_SPACING` = 0.25 (overlapping). Above 1, more line shows between stamps.
- Stamp centres are `2^k` meters apart, with `k` chosen per fragment so the spacing is 1–2×
  the repeat length. Every second stamp fades out over `fract(level)` in 0.9..1, so nothing
  pops when `k` changes. The stamp is never stretched.
- The grid starts at the first vertex: the first stamp's leading edge touches it at every zoom.
  It runs to the last vertex, which cuts off the final stamp.
- **Each stamp belongs to the segment containing its centre** and is drawn in that segment's
  direction, also where it reaches past an interior vertex. Near a vertex, each pixel also
  draws the other segment's stamps, measured in that segment's frame from per-vertex frames
  (eye-space position, incoming and outgoing direction, up) that the CPU uploads every frame. A
  stamp over a corner is therefore whole, never torn.
- Stamps are only visible inside the line's footprint (the draped bands plus the corner
  wedges), so symbols taller than the line width are clipped.

**Max height.** Above it (`sizeScale < 1`) both layers keep their ground size. The geometry
stays `v_width` pixels wide, so the pattern is drawn in a centred band `v_width × sizeScale`
pixels wide, and the line looks thinner.

**Inputs from `GroundPolylinePrimitive`:**
- `materialInput.st.s` is the arc length along the **whole** line, normalized to 0..1.
- `materialInput.st.t` is the position across the width, 0..1.
- `v_width` is the line width in CSS pixels. Cesium only provides it when the material source
  contains the exact declaration `in float v_width;`.

### 4.2 Uniforms

| name | JS initial value | meaning |
|---|---|---|
| `lineImage`, `stampImage` | the option, or `Material.DefaultImageId` for `null` | 1×1 placeholder = layer off |
| `lineColor`, `stampColor` | `Color.WHITE` default | tints |
| `spacing` | `1` default | stamp repeat as a multiple of the stamp length; clamped to ≥ `MIN_SPACING` = 0.25 (a GLSL `const` and a matching JS `const`) |
| `lineShift`, `stampShift` | `0` | zoom settle level shifts (Step 2) |
| `sizeScale` | `1` | max height factor (Step 3) |
| `lineLength` | `1` | geodesic length of the line in meters (set by `setPositions`) |
| `preciseMetersPerPixel` | `0` | switch-over threshold for the close-zoom path |
| `referenceA`, `referenceB` | `new Cartesian4()` | xyz: point on the line in eye coordinates; w: distance along the line mod `modulus` |
| `tangentA`, `tangentB` | `new Cartesian4()` | xyz: unit line direction in eye coordinates; w: 1 if valid, else 0 |
| `rangeA`, `rangeB` | `new Cartesian2()` | distance along the line from that reference point to its segment's start (x, ≤ 0) and end (y, ≥ 0) |
| `lineEndsA`, `lineEndsB` | `new Cartesian2()` | that reference's segment: x = 1 if it starts the line, y = 1 if it ends it |
| `vertexDistances` | `Material.DefaultImageId` | float data texture, `vertexCount × 1`: distance along the line of each vertex, ascending, both ends included |
| `vertexCount` | `0` | number of texels in `vertexDistances` |
| `vertexFrames` | `Material.DefaultImageId` | float data texture, `vertexCount × 4`, eye coordinates. Texel `(v, 0)`: position, `w = 1` if interior. Rows 1, 2, 3: incoming direction, outgoing direction, up. Re-uploaded every frame. |
| `nearVertex` | `new Cartesian4()` | close-zoom path: the interior vertex nearest the camera. xyz: eye position; w: 0 = none, else `1 + (2 if the segment before starts the line) + (4 if the segment after ends it)` |
| `nearIncoming`, `nearOutgoing` | `new Cartesian4()` | xyz: its incoming / outgoing direction; w: length of the segment before / after |
| `nearUp` | `new Cartesian4()` | xyz: its up; w: its distance along the line mod `modulus` |

`TYPE = "PolylinePatternWorld"`. In `create()`:
- set `material.segments = []`, `material.vertices = []`, and
  `material.pendingVertexDistances` and `material.pendingVertexFrames` to `undefined`;
- set `material.lineWidth = 1`, `material.lineAspect = imageAspect(lineImage)` and
  `material.stampAspect = imageAspect(stampImage)`. `imageAspect` returns `width / height` from
  `naturalWidth/naturalHeight` (or `width/height`) for an image or canvas, and 1 for `null` or a
  URL that hasn't loaded. These are CPU-side copies, used only by `updateCamera`;
- set `material.zoomSettle = createZoomSettle()`, `material.maxHeight` and
  `material.heightTransition`;
- wrap `material.update` (before calling `mipmapTexture`). Creating the data textures needs the
  WebGL context, which only `update(context)` receives:
  ```js
  const originalUpdate = material.update.bind(material);
  material.update = function (context) {
    const uniforms = material.uniforms;
    if (material.pendingVertexDistances) {
      const distances = material.pendingVertexDistances;
      uniforms.vertexDistances = createDataTexture(context, distances.length, 1, (data) => {
        distances.forEach((distance, i) => { data[i * 4] = distance; });
      });
      uniforms.vertexCount = distances.length;
      material.pendingVertexDistances = undefined;
    }
    if (material.pendingVertexFrames) {
      const { width, data } = material.pendingVertexFrames;
      const texture = uniforms.vertexFrames;
      if (texture instanceof Texture && texture.width === width && texture.height === 4) {
        texture.copyFrom({ source: { width, height: 4, arrayBufferView: data } });  // reuse
      } else {
        uniforms.vertexFrames = createDataTexture(context, width, 4, (target) => target.set(data));
      }
      material.pendingVertexFrames = undefined;
    }
    originalUpdate(context);
    // Once an image has loaded, take its aspect ratio from the (private) texture map.
    for (const [uniformName, key] of [["lineImage", "lineAspect"], ["stampImage", "stampAspect"]]) {
      const texture = material._textures[uniformName];
      if (texture && texture !== context.defaultTexture && texture.height > 0) {
        material[key] = texture.width / texture.height;
      }
    }
  };
  ```
- `createDataTexture(context, width, height, fill)` allocates a `Float32Array(width * height * 4)`,
  calls `fill(data)`, and returns a `width × height` `Texture`. It uses
  `pixelFormat: PixelFormat.RGBA`, `pixelDatatype: PixelDatatype.FLOAT` and `flipY: false`, with
  a NEAREST / CLAMP_TO_EDGE `Sampler`. Rows are stored one after another, so texel `(x, y)` is
  at `data[(y * width + x) * 4]`;
- call `mipmapTexture(material, "lineImage", { wrapS: TextureWrap.REPEAT, wrapT: TextureWrap.CLAMP_TO_EDGE })`,
  then return `mipmapTexture(material, "stampImage", { wrapS: TextureWrap.CLAMP_TO_EDGE, wrapT: TextureWrap.CLAMP_TO_EDGE })`.

`setImages(material, { lineImage, stampImage })`: for each image that isn't `undefined`, set the
uniform to `image ?? Material.DefaultImageId` and refresh `lineAspect` / `stampAspect` with
`imageAspect`.

> ⚠️ The line image needs `wrapS: REPEAT`: it's sampled at `fract(phase)`, and filtering must
> wrap across the seam. Stamps need `CLAMP_TO_EDGE` so their edges don't bleed in from the
> opposite side.

### 4.3 Fragment shader

Declare `in float v_width;` at the top of the source, before the uniforms, then
`const float MIN_SPACING = 0.25;` and the uniforms. Before `czm_getMaterial`, add these helpers:

```glsl
float vertexDistanceAt(int i) { return texelFetch(vertexDistances, ivec2(i, 0), 0).r; }

// Index i of the segment [vertex i, vertex i + 1] containing c (clamped to the first / last
// segment), by binary search. Requires vertexCount >= 2.
int segmentIndex(float c) {
    int lo = 0;
    int hi = int(vertexCount) - 1;
    for (int i = 0; i < 32; i++) {
        if (hi - lo <= 1) { break; }
        int mid = (lo + hi) / 2;
        if (vertexDistanceAt(mid) <= c) { lo = mid; } else { hi = mid; }
    }
    return lo;
}

// A filtered sample, fringe-free, tinted and premultiplied.
vec4 tinted(vec4 s, vec4 tint) {
    s.rgb = min(s.rgb / max(s.a, 0.0001), 1.0) * s.a;
    return vec4(s.rgb * tint.rgb, s.a) * tint.a;
}

vec4 over(vec4 top, vec4 bottom) { return top + bottom * (1.0 - top.a); }

// The line layer at "along" meters along the line, "t" across it, for a band "widthPixels" wide.
vec4 lineAt(float along, float t, float widthPixels, float metersPerPixel) {
    if (t <= 0.0 || t >= 1.0) { return vec4(0.0); }
    vec2 imageSize = vec2(textureSize(lineImage, 0));
    float natural = widthPixels * imageSize.x / imageSize.y * metersPerPixel;  // one period, m
    float level = log2(natural) + lineShift;
    float k = ceil(level);
    float blend = smoothstep(0.8, 1.0, k - level);  // partly faded for fract(level) in 0..0.2
    float period = exp2(k);                          // anchored at the line start (distance 0)
    float phase = along / period;
    float lod = max(log2(imageSize.x * metersPerPixel / (period * czm_pixelRatio)), 0.0);
    vec4 coarse = textureLod(lineImage, vec2(fract(phase), t), lod);
    vec4 fine = textureLod(lineImage, vec2(fract(2.0 * phase), t), lod + 1.0);
    return tinted(mix(coarse, fine, blend), lineColor);
}

// The stamps of the segment [a, b] at "along" meters along the line, "t" across it.
// lineEnds: x = 1 if the segment starts the line, y = 1 if it ends it.
vec4 stampsAt(float along, float t, float a, float b, vec2 lineEnds, float gridSpacing,
              float fadeOut, float stampMeters, float lod) {
    vec4 result = vec4(0.0);
    if (t <= 0.0 || t >= 1.0) { return result; }
    // Centres: origin + i * gridSpacing, with the first stamp's leading edge at distance 0.
    // The segment owns the stamps whose centre lies in [a, b).
    float halfStamp = 0.5 * stampMeters;
    float origin = halfStamp;
    float first = ceil((a - origin) / gridSpacing);
    float last = ceil((b - origin) / gridSpacing) - 1.0;
    if (lineEnds.y > 0.5) {
        // The last segment also owns stamps that start before its end but are centred beyond
        // it, so the pattern runs to the last vertex, which cuts the final stamp off.
        last = ceil((b + halfStamp - origin) / gridSpacing) - 1.0;
    }
    if (first > last) { return result; }
    // The nearest stamp and, for spacing < 1 where stamps overlap, two neighbours either side.
    float nearest = clamp(floor((along - origin) / gridSpacing + 0.5), first, last);
    for (int j = -2; j <= 2; j++) {
        float i = nearest + float(j);
        if (i < first || i > last) { continue; }
        float center = origin + i * gridSpacing;
        float u = 0.5 + (along - center) / stampMeters;   // divide by the STAMP, not the repeat
        if (u <= 0.0 || u >= 1.0) { continue; }
        float keep = mod(i, 2.0) < 0.5 ? 1.0 : 1.0 - fadeOut;   // zoom-level fade
        // Stamps must not overhang the first vertex (with spacing < 1 the grid has stamps
        // before its first whole one). One exactly touching it is kept whole.
        float startGap = lineEnds.x > 0.5 ? center - a : 1e30;
        keep *= smoothstep(0.9 * halfStamp, halfStamp, startGap);
        if (keep > 0.0) {
            result = over(tinted(textureLod(stampImage, vec2(u, t), lod), stampColor) * keep, result);
        }
    }
    return result;
}
```

Then, inside `czm_getMaterial`:

```glsl
czm_material material = czm_getDefaultMaterial(materialInput);

// A layer whose image is null or still loading is bound to Cesium's 1x1 placeholder.
bool hasLine = textureSize(lineImage, 0).x > 1;
bool hasStamp = textureSize(stampImage, 0).x > 1;
if (!hasLine && !hasStamp) { discard; }

float d = materialInput.st.s * lineLength;     // meters along the line

// Pixel size at this fragment, computed the way GroundPolylinePrimitive sizes its width.
float depth = czm_unpackDepth(texture(czm_globeDepthTexture, gl_FragCoord.xy / czm_viewport.zw));
vec4 eyeCoordinate = czm_windowToEyeCoordinates(gl_FragCoord.xy, depth);
eyeCoordinate /= eyeCoordinate.w;
float metersPerPixel = max(czm_metersPerPixel(eyeCoordinate), 1e-6);   // per CSS pixel
// Max height: draw in a centred band v_width * sizeScale pixels wide. Below one pixel the band
// stays one pixel wide and fades with its coverage instead of aliasing.
float bandPixels = min(max(v_width * sizeScale, 1.0), v_width);
float coverage = v_width * sizeScale / bandPixels;
float width = bandPixels * metersPerPixel;     // band width on the ground, meters

// Close-zoom precision path (see 4.5).
bool precise = false;
vec2 preciseVertices = vec2(0.0);   // the chosen segment's two ends, same units as d
vec2 preciseLineEnds = vec2(0.0);
if (metersPerPixel < preciseMetersPerPixel && tangentA.w > 0.5) {
    precise = true;
    vec3 toA = eyeCoordinate.xyz - referenceA.xyz;
    vec3 toB = eyeCoordinate.xyz - referenceB.xyz;
    float alongA = dot(toA, tangentA.xyz);
    float alongB = dot(toB, tangentB.xyz);
    float offA = length(toA - alongA * tangentA.xyz);
    float offB = tangentB.w > 0.5 ? length(toB - alongB * tangentB.xyz) : 1e30;
    bool useA = offA <= offB;
    d = useA ? referenceA.w + alongA : referenceB.w + alongB;
    preciseVertices = useA ? referenceA.w + rangeA : referenceB.w + rangeB;
    preciseLineEnds = useA ? lineEndsA : lineEndsB;
}

// The segment this fragment is on.
float segmentStart = 0.0;
float segmentEnd = lineLength;
vec2 lineEnds = vec2(1.0);
int segment = 0;
if (precise) {
    segmentStart = preciseVertices.x;
    segmentEnd = preciseVertices.y;
    lineEnds = preciseLineEnds;
} else if (vertexCount >= 2.0) {
    segment = segmentIndex(d);
    segmentStart = vertexDistanceAt(segment);
    segmentEnd = vertexDistanceAt(segment + 1);
    lineEnds = vec2(segment == 0 ? 1.0 : 0.0, segment + 2 >= int(vertexCount) ? 1.0 : 0.0);
}
float t = (materialInput.st.t - 0.5) * v_width / bandPixels + 0.5;   // 0..1 across the band

vec4 result = vec4(0.0);
if (hasLine) {
    result = lineAt(clamp(d, segmentStart, segmentEnd), t, bandPixels, metersPerPixel);
}

if (hasStamp) {
    vec2 stampSize = vec2(textureSize(stampImage, 0));
    float stampMeters = width * stampSize.x / stampSize.y;
    float repeatMeters = stampMeters * max(spacing, MIN_SPACING);
    float level = log2(repeatMeters) + stampShift;
    float k = ceil(level);                               // ceil, NOT floor
    float gridSpacing = exp2(k);                         // 1x..2x a repeat
    float fadeOut = smoothstep(0.9, 1.0, 1.0 - (k - level));
    float lod = max(log2(stampSize.x * metersPerPixel / (stampMeters * czm_pixelRatio)), 0.0);

    // The nearest interior vertex: position, directions and up (eye coordinates), its distance
    // along the line, the lengths of the segments either side, and whether those are the
    // line's first / last segment.
    bool haveVertex = false;
    vec3 vertexPosition = vec3(0.0);
    vec3 incoming = vec3(1.0, 0.0, 0.0);
    vec3 outgoing = vec3(1.0, 0.0, 0.0);
    vec3 up = vec3(0.0, 0.0, 1.0);
    float dv = 0.0;
    float lengthBefore = 0.0;
    float lengthAfter = 0.0;
    bool beforeStartsLine = false;
    bool afterEndsLine = false;
    if (precise) {
        if (nearVertex.w > 0.5) {
            haveVertex = true;
            beforeStartsLine = mod(floor(nearVertex.w / 2.0), 2.0) > 0.5;
            afterEndsLine = mod(floor(nearVertex.w / 4.0), 2.0) > 0.5;
            vertexPosition = nearVertex.xyz;
            incoming = nearIncoming.xyz;
            outgoing = nearOutgoing.xyz;
            up = nearUp.xyz;
            dv = nearUp.w;
            lengthBefore = nearIncoming.w;
            lengthAfter = nearOutgoing.w;
        }
    } else if (vertexCount >= 2.0 && textureSize(vertexFrames, 0) == ivec2(int(vertexCount), 4)) {
        int v = abs(d - vertexDistanceAt(segment)) <= abs(d - vertexDistanceAt(segment + 1))
            ? segment : segment + 1;
        vec4 frame = texelFetch(vertexFrames, ivec2(v, 0), 0);
        if (frame.w > 0.5) {
            haveVertex = true;
            vertexPosition = frame.xyz;
            incoming = texelFetch(vertexFrames, ivec2(v, 1), 0).xyz;
            outgoing = texelFetch(vertexFrames, ivec2(v, 2), 0).xyz;
            up = texelFetch(vertexFrames, ivec2(v, 3), 0).xyz;
            dv = vertexDistanceAt(v);
            lengthBefore = dv - vertexDistanceAt(v - 1);
            lengthAfter = vertexDistanceAt(v + 1) - dv;
            beforeStartsLine = v == 1;
            afterEndsLine = v + 2 >= int(vertexCount);
        }
    }
    // Past the vertex along this fragment's own segment (the mitered wedge, and the band
    // beyond the vertex), st.s is clamped, so d can't place stamps there. Test it exactly per
    // pixel from the fragment's position.
    vec3 offset = eyeCoordinate.xyz - vertexPosition;
    bool vertexAtEnd = abs(dv - segmentEnd) <= abs(dv - segmentStart);
    bool pastOwnEnd = haveVertex
        && (vertexAtEnd ? dot(offset, incoming) > 0.0 : dot(offset, outgoing) < 0.0);

    // This segment's stamps, measured along the line.
    if (!pastOwnEnd) {
        result = over(stampsAt(d, t, segmentStart, segmentEnd, lineEnds, gridSpacing,
                               fadeOut, stampMeters, lod), result);
    }

    // Near an interior vertex: stamps reaching across it, measured in their own segment's
    // frame. That adds the other segment's stamps and, past the vertex, this segment's too.
    float reach = 0.5 * stampMeters + width;
    if (haveVertex && (pastOwnEnd || abs(d - dv) < reach)) {
        if (pastOwnEnd || !vertexAtEnd) {
            float along = dv + dot(offset, incoming);
            float across = 0.5 + dot(offset, normalize(cross(incoming, up))) / width;
            result = over(stampsAt(along, across, dv - lengthBefore, dv,
                                   vec2(beforeStartsLine ? 1.0 : 0.0, 0.0), gridSpacing,
                                   fadeOut, stampMeters, lod), result);
        }
        if (pastOwnEnd || vertexAtEnd) {
            float along = dv + dot(offset, outgoing);
            float across = 0.5 + dot(offset, normalize(cross(outgoing, up))) / width;
            result = over(stampsAt(along, across, dv, dv + lengthAfter,
                                   vec2(0.0, afterEndsLine ? 1.0 : 0.0), gridSpacing,
                                   fadeOut, stampMeters, lod), result);
        }
    }
}

result *= coverage;
if (result.a < 0.005) { discard; }
vec4 fragColor = czm_gammaCorrect(vec4(result.rgb / result.a, result.a));
material.emission = fragColor.rgb;   // emission, not diffuse (unlit line)
material.alpha = fragColor.a;
return material;
```

**Pitfalls:**
- **Don't** get `metersPerPixel` from `dFdx`/`dFdy` of `d`. `d` comes from the depth buffer,
  and its derivatives are noisy, which makes the X's speckled and broken. Use
  `czm_metersPerPixel(eyeCoordinate)`.
- **Don't** use plain `texture()` for either image. The stamp `u` jumps between stamps and the
  line phase wraps, so automatic mip selection breaks. Use `textureLod` with the explicit `lod`
  shown (the line's `fine` sample is one level coarser, `lod + 1.0`).
- **Don't** multiply sizes by `czm_pixelRatio` (see "Pixel size" in section 0). It belongs only
  in the `lod`.
- Divide by `stampMeters`, not `repeatMeters`, when computing `u`. Otherwise `spacing`
  stretches the stamp instead of adding a gap.
- Skip stamps whose `u` falls outside the open range (0, 1); clamped samples there would draw
  the stamp's edge column.
- Composite in **premultiplied** alpha (`tinted` then `over`) and un-premultiply once at the
  end. Mixing straight and premultiplied colors darkens overlaps.
- **Don't** detect the wedge with screen-space derivatives of `st.s`. That misclassifies whole
  2×2 pixel quads at the wedge edge. Use the per-pixel `pastOwnEnd` test against the vertex
  frame.
- In the wedge, don't draw `stampsAt(d, ...)`: `d` is clamped to the vertex there, and every
  pixel would read the same stamp column, smearing it into a bracket.
- The line layer gets `clamp(d, segmentStart, segmentEnd)`, so in the close-zoom path the wedge
  also shows the column at the vertex.
- Decide whether a stamp is drawn **per stamp**, from its `center`, not per fragment. Otherwise
  part of an X disappears and the rest stays.
- The material is inserted **before** Cesium's own polyline shader code. Don't try to read
  Cesium's varyings such as `v_endEcAndStartEcX`: redeclaring them is a GLSL error.
- Never name a local variable `step`; it's a GLSL built-in.

### 4.4 `setPositions(material, positions, width)` (CPU)

Set `material.lineWidth = width`. Then, for each consecutive pair of positions `i-1 → i`:

1. Build the geodesic with
   `new EllipsoidGeodesic(ellipsoid.cartesianToCartographic(p0), ellipsoid.cartesianToCartographic(p1), ellipsoid)`.
2. Read `length = geodesic.surfaceDistance` and skip the pair if `!(length > 0)`.
3. Push `{ index, geodesic, length, start, a: normalize(p0), b: normalize(p1) }`, where `index`
   is the position in `material.segments` and `start` is the running total of the previous
   segments' lengths.

Then set `uniforms.lineLength = Math.max(total, 1e-3)` and
`material.vertices = computeVertices(material.segments)`, and set
`material.pendingVertexDistances = material.vertices.map((vertex) => vertex.distance)`. The
wrapped `update` uploads it on the next frame.

`computeVertices(segments)` returns `[]` for no segments, otherwise one entry per vertex
(`segments.length + 1`), in world space. With `before = segments[i - 1]` and
`after = segments[i]`:
- `position`: `pointAt(after, 0)`, or `pointAt(before, 1)` for the last vertex (`pointAt` is in
  4.6);
- `incoming = directionAt(before, 1)` and `outgoing = directionAt(after, 0)`; at an end, use
  the one that exists for both. `directionAt` is
  `normalize(pointAt(f + δ) - pointAt(f - δ))` with `δ = min(1 / length, 0.5)` (about 1 m) and
  the fractions clamped to 0..1;
- `up = Ellipsoid.WGS84.geodeticSurfaceNormal(position)`;
- `distance`: `after.start`, or `before.start + before.length` for the last vertex;
- `interior = Boolean(before && after)`.

> `lineLength` must be the geodesic length. Cesium normalizes `st.s` by the line's arc length,
> and a wrong length stretches the images.

### 4.5 `updateCamera(material, scene)` (CPU, double precision)

**Why the precision part is needed:** `st.s` is float32, so `d` only resolves to
`lineLength × 2^-24`. That's 22 cm on a 3,600 km line, which smears the X's into a bar at 1 m
zoom. Close up, the shader therefore measures distance from reference points that the CPU
computes exactly.

1. **Max height:**
   `uniforms.sizeScale = sizeScale(camera.positionCartographic.height, material.maxHeight, material.heightTransition)`.
2. **Zoom settle.** In CSS pixels, like the shader:
   ```js
   const stampPixels = material.lineWidth * material.stampAspect * Math.max(uniforms.spacing, MIN_SPACING);
   const linePixels = material.lineWidth * material.lineAspect;
   const metersPerPixel = referenceMetersPerPixel(scene) * uniforms.sizeScale;
   const shifts = updateZoomSettle(material.zoomSettle, scene, {
     line: { level: Math.log2(linePixels * metersPerPixel), window: [0, 0.2] },
     stamp: { level: Math.log2(stampPixels * metersPerPixel), window: [0.9, 1] },
   });
   uniforms.lineShift = shifts.line;
   uniforms.stampShift = shifts.stamp;
   ```
   The windows must match the shader's fades: the line cross-fades over `fract(level)` in
   0..0.2, the stamps over 0.9..1.
3. **Threshold and modulus:**
   ```js
   const step = uniforms.lineLength * 2 ** -24;
   uniforms.preciseMetersPerPixel = step * PRECISE_STEP_FRACTION;   // 64
   const repeatPixels = Math.max(stampPixels, linePixels);
   const maxSpacing = 4 * repeatPixels * uniforms.preciseMetersPerPixel;
   const modulus = 2 ** Math.ceil(Math.log2(Math.max(2 * maxSpacing, 1e-3)));
   ```
   Stamp spacing stays under 4 repeat lengths, and the line period under 4 image lengths (2×,
   plus the level shift). A power-of-two modulus of at least twice that keeps the stamp-index
   parity (odd/even fade) and the line phase consistent. It reads `spacing` every frame, so
   changing the uniform at runtime is safe.
4. For each segment, run `nearestPointOnSegment(segment, camera.positionWC)` (step 4.6) and keep
   the **two** with the smallest `distance`, as `{ segment, ...nearest }`. Two segments are
   needed so corners near the camera work.
5. Call
   `setReference(uniforms.referenceA, uniforms.tangentA, uniforms.rangeA, uniforms.lineEndsA, first, segmentCount, camera, modulus)`,
   and the same for B with `second`. `setReference` does the following:
   - If there's no candidate, set `tangent.w = 0` and return.
   - `lineEnds.x = segment.index === 0 ? 1 : 0` and
     `lineEnds.y = segment.index === segmentCount - 1 ? 1 : 0`.
   - `range.x = -fraction * segment.length` and `range.y = (1 - fraction) * segment.length`.
   - `eye = Matrix4.multiplyByPoint(camera.viewMatrix, point)`.
   - `distanceAlong = segment.start + fraction * segment.length`.
   - `reference = (eye.x, eye.y, eye.z, distanceAlong % modulus)`.
   - `direction = normalize(Matrix4.multiplyByPointAsVector(camera.viewMatrix, tangent))`.
   - `tangent = (direction.x, direction.y, direction.z, 1)`.
   - Write the results with `Cartesian4.fromElements(..., result)` into the existing uniform
     objects.
6. **Vertex frames**, `updateVertexFrames(material, camera, modulus)`:
   1. Set `uniforms.nearVertex.w = 0`; return if there are no vertices.
   2. Reuse `material.vertexFrameData`, a `Float32Array(width * 4 * 4)` with
      `width = vertices.length`; reallocate only when the size changes.
   3. For each vertex `v`, write in eye coordinates:
      - texel `(v, 0)`: `viewMatrix × position`, with `w = interior ? 1 : 0`;
      - texels `(v, 1)`, `(v, 2)`, `(v, 3)`: `multiplyByPointAsVector(viewMatrix, …)` of
        `incoming`, `outgoing` and `up`, with `w = 0`.
   4. Of the interior vertices, find the one nearest the camera (smallest `|eye|`, since the
      camera is the eye-space origin). Copy it into the close-zoom uniforms:
      - `nearVertex = (eye, 1 + (v === 1 ? 2 : 0) + (v === width - 2 ? 4 : 0))`;
      - `nearIncoming = (incoming in eye coordinates, vertex.distance - vertices[v - 1].distance)`;
      - `nearOutgoing = (outgoing in eye coordinates, vertices[v + 1].distance - vertex.distance)`;
      - `nearUp = (up in eye coordinates, vertex.distance % modulus)`.
   5. Set `material.pendingVertexFrames = { width, data }`; the wrapped `update` uploads it.

   This runs every frame because eye coordinates change with the camera. They're computed in
   double precision on the CPU, so they stay precise at close zoom.

### 4.6 `nearestPointOnSegment(segment, position)` (CPU)

1. **Great-circle first guess:**
   - `c = normalize(position)` and `n = normalize(cross(a, b))`.
   - `projected = c - dot(c, n) * n`.
   - `angle = atan2(dot(cross(a, projected), n), dot(a, projected))`.
   - `fraction = clamp(angle / angleBetween(a, b), 0, 1)`, using 0 if the segment angle is 0.
2. **Refine on the real geodesic**, `REFINE_ITERATIONS = 3`:
   - `point = pointAt(fraction)` and `tangent = directionAt(fraction)`.
   - `fraction = clamp(fraction + dot(position - point, tangent) / length, 0, 1)`.
   - After the last iteration, recompute `point` and `tangent` at the final `fraction`.
3. `pointAt(segment, fraction, result)`:
   - clamp `fraction` to 0..1;
   - call `geodesic.interpolateUsingFraction(...)`;
   - set the resulting cartographic's height to 0;
   - convert it with `Ellipsoid.WGS84.cartographicToCartesian`.
4. Return `{ point, tangent, fraction, distance: Cartesian3.distance(position, point) }`.

Use module-level scratch `Cartesian3`/`Cartographic` objects for temporaries. Allocate **new**
objects for the returned `point` and `tangent`, and for each vertex's fields.

---

## Step 5 — `src/solutions/worldSpace/PolygonPatternMaterial.js`

### 5.1 Behaviour to achieve

**The tile image** is a seamless 256×256 45° hatch. It fills the draped polygon as follows:

- **Anchoring:** the hatch is pinned to the ground, with square tiles aligned to east/north at
  the polygon's center.
- **Size:** tiles are about 0.7×–1.4× `tileSize` pixels on screen at every zoom. The tile is
  `2^k` meters, and over the last 20% of a level the shader cross-fades to `2^(k+1)`.
- **Max height:** above it, the tile keeps its ground size.

**Approach:**
- **Don't** use `materialInput.st`.
- **Don't** use `positionToEyeEC` as the position. On a `GroundPrimitive` it comes from the depth
  buffer, which is too coarse: the hatch turns into blocks or a flat solid fill.
- Use only its **direction**, and intersect that view ray with a sphere fitted under the camera.

### 5.2 Uniforms

| name | JS initial value | meaning |
|---|---|---|
| `image`, `color` | from options (`Color.WHITE` default) | |
| `tileSize` | `48` default | target tile size in CSS pixels |
| `eyeToLocal` | `Matrix4.toArray(Matrix4.IDENTITY)` | eye coords → polygon east/north/up frame (**array**, not `Matrix4`) |
| `radius` | `Ellipsoid.WGS84.maximumRadius` | radius of the sphere under the camera |
| `cameraHeight` | `1` | camera height above that sphere (m) |
| `cameraUp` | `new Cartesian3(0, 0, 1)` | unit vector, sphere center → camera, local frame |
| `cameraHigh`, `cameraLow` | `new Cartesian2()` | camera east/north = `high + low` (float split) |
| `levelShift` | `0` | zoom settle level shift (Step 2) |
| `sizeScale` | `1` | max height factor (Step 3) |

`TYPE = "PolygonPatternWorld"`. In `create()`:
- set `material.localToWorld = Matrix4.clone(Matrix4.IDENTITY)` and
  `material.worldToLocal = Matrix4.clone(Matrix4.IDENTITY)`;
- set `material.zoomSettle = createZoomSettle()`, `material.maxHeight` (default `Infinity`) and
  `material.heightTransition` (default 0);
- return `mipmapTexture(material, "image")`, which uses REPEAT wrap; the tiling depends on it.

### 5.3 Fragment shader, in this order

```glsl
// Placeholder: draw nothing until the real image is there.
if (textureSize(image, 0).x <= 1) {
    discard;
}

vec3 directionEC = normalize(-materialInput.positionToEyeEC);     // direction only
vec3 direction = normalize(mat3(eyeToLocal) * directionEC);       // into local frame

// Ray-sphere, cancellation-free near root: t^2 + 2bt + c = 0
float b = (radius + cameraHeight) * dot(cameraUp, direction);
float c = cameraHeight * (cameraHeight + 2.0 * radius);
float t = c / (-b + sqrt(max(b * b - c, 0.0)));

vec2 p = cameraLow + t * direction.xy;      // east/north meters, minus cameraHigh
vec2 gradX = dFdx(p);
vec2 gradY = dFdy(p);
float metersPerPixel = max(czm_metersPerPixel(vec4(directionEC * t, 1.0)), 1e-6);

// +0.5 centres the tile on tileSize (0.7x..1.4x); cross-fade over fract(level) in 0.8..1.
float level = log2(tileSize * metersPerPixel * sizeScale) + 0.5 + levelShift;
float k = floor(level);                     // floor here (cross-fade between k and k+1)
float blend = smoothstep(0.8, 1.0, level - k);
float size0 = exp2(k);
float size1 = size0 * 2.0;

vec2 uv0 = (mod(cameraHigh, size0) + p) / size0;
vec2 uv1 = (mod(cameraHigh, size1) + p) / size1;
vec4 tex0 = textureGrad(image, uv0, gradX / size0, gradY / size0);
vec4 tex1 = textureGrad(image, uv1, gradX / size1, gradY / size1);
vec4 tex = mix(tex0, tex1, blend);

tex.rgb = min(tex.rgb / max(tex.a, 0.0001), 1.0);   // un-premultiply
vec4 fragColor = tex * color;
if (fragColor.a < 0.005) {
    discard;
}
fragColor = czm_gammaCorrect(fragColor);
material.diffuse = fragColor.rgb;    // diffuse (appearance is flat)
material.alpha = fragColor.a;
```

**Pitfalls:**
- **Don't** compute `c` as `dot(o, o) + 2.0 * radius * o.z`. That suffers catastrophic float
  cancellation. Use `h * (h + 2R)` with `h` from the CPU.
- **Don't** add `cameraHigh` to `p` directly. That loses about 6 cm of precision when the camera
  is 1,000 km from the origin, and the pattern stutters while panning. Wrap it first with
  `mod(cameraHigh, size)`, which is exact because `size` is a power of two.
- Use `textureGrad` with the derivatives of `p`, which are smooth. That gives correct mip
  selection and anisotropy at tilted views.

### 5.4 `setOrigin(material, positions)` (CPU)

1. `center = Ellipsoid.WGS84.scaleToGeodeticSurface(BoundingSphere.fromPoints(positions).center, new Cartesian3())`.
2. `Transforms.eastNorthUpToFixedFrame(center, Ellipsoid.WGS84, material.localToWorld)`.
3. `Matrix4.inverseTransformation(material.localToWorld, material.worldToLocal)`.

### 5.5 `updateCamera(material, scene)` (CPU, double precision)

1. **Max height and zoom settle:**
   ```js
   uniforms.sizeScale = sizeScale(camera.positionCartographic.height, material.maxHeight, material.heightTransition);
   const metersPerPixel = referenceMetersPerPixel(scene) * uniforms.sizeScale;
   const level = Math.log2(uniforms.tileSize * metersPerPixel) + 0.5;
   uniforms.levelShift = updateZoomSettle(material.zoomSettle, scene, {
     tile: { level, window: [0.8, 1] },
   }).tile;
   ```
2. **Eye-to-local matrix:**
   - `modelView = camera.viewMatrix × material.localToWorld`, computed with `Matrix4.multiply`;
   - `eyeToLocal = Matrix4.inverseTransformation(modelView)`;
   - write it with `Matrix4.pack(eyeToLocal, uniforms.eyeToLocal)`.
3. **Sphere under the camera.** Refit it **every frame**; don't fit it at the polygon's center.
   - `nadir = Ellipsoid.WGS84.scaleToGeodeticSurface(camera.positionWC)`. Return early if this is
     undefined.
   - `up = ellipsoid.geodeticSurfaceNormal(nadir)`.
   - `radius = gaussianRadius(ellipsoid, nadir)` (step 5.6).
   - `centerWorld = nadir - up * radius`.
   - `center = Matrix4.multiplyByPoint(material.worldToLocal, centerWorld)`.
4. **Camera values:**
   - `eye = Matrix4.getTranslation(eyeToLocal)` is the camera in the local frame.
   - `fromCenter = eye - center` and `distance = |fromCenter|`.
   - Set `uniforms.radius = radius` and `uniforms.cameraHeight = distance - radius`.
   - Set `uniforms.cameraUp = fromCenter / distance`, writing into the existing object.
5. **Float split:**
   ```js
   uniforms.cameraHigh.x = Math.fround(eye.x);
   uniforms.cameraHigh.y = Math.fround(eye.y);
   uniforms.cameraLow.x = eye.x - uniforms.cameraHigh.x;
   uniforms.cameraLow.y = eye.y - uniforms.cameraHigh.y;
   ```

**Pitfall:** a sphere fitted at the polygon's center sits about 50 m below the real surface
1,000 km away. The pattern then lags the camera and looks stuck to the screen up close. The
symptom is `cameraHeight` reading about 50 m while the camera is actually 1 m above the ground.

### 5.6 `gaussianRadius(ellipsoid, surfacePoint)`

```js
const a = ellipsoid.maximumRadius;
const e2 = 1 - (ellipsoid.minimumRadius / a) ** 2;
const sinLat = Math.sin(ellipsoid.cartesianToCartographic(surfacePoint, scratch).latitude);
const w2 = 1 - e2 * sinLat * sinLat;
const n = a / Math.sqrt(w2);
const m = (a * (1 - e2)) / (w2 * Math.sqrt(w2));
return Math.sqrt(m * n);
```

---

## Step 6 — Verify

Run `npm run dev`, then work through these checks. Use a real GPU. Chrome's software renderer
hides the precision bugs. For headless Chrome, launch with
`--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist`.

1. **Basic look at 15 km camera height:**
   - The polyline shows the line image with evenly spaced, upright X's on top; the first X
     touches the first vertex.
   - Each line image (solid, dashed, wave, sawtooth) and each stamp image (X, arrow) works, and
     "None" removes that layer.
   - The polygon shows continuous 45° hatching with no seams.
   - Dragging a vertex updates both live, and doesn't stretch the line pattern.
2. **Corners:** an X over a corner is whole and points along its own segment, with no torn
   halves and no stray bracket in the wedge. Check it both zoomed out and at 1 m.
3. **Spacing slider** from 0.25 to 4: stamps overlap below 1 and show more line above 1, and
   are never stretched.
4. **Zoom sweep, top-down, at 500 km, 60 km, 15 km, 3 km, 800 m, 150 m and 1 m:**
   - X spacing, line period and hatch density stay roughly constant on screen.
   - No solid fills, no moiré.
   - Stop the camera mid-fade: within about a second the pattern settles, with no X or hatch
     line left half faded at the screen centre.
5. **Max height:** with the slider at 1×, zoom out past the height at which the shape fills the
   view. The patterns, and the line's thickness, shrink with the ground instead of keeping
   their screen size. Far right turns it off.
6. **Tilted views (-25° to -40°):** the patterns foreshorten like paint on the ground, with no
   blocks or streaks.
7. **Continent-scale polyline:** it follows the Earth's curvature and never cuts through the
   globe.
8. **Max zoom on a large shape** (a polygon about 2,500 km across and a 3,600 km polyline):
   - Aim the camera at a point actually on the line by interpolating with `EllipsoidGeodesic`.
     Averaging the endpoints' longitude/latitude misses a 1 m view.
   - At 1 m height, step the camera 1 cm at a time. The pattern must move with the ground,
     about 7 px per cm for an 800 px-wide view. Check this with
     `SceneTransforms.worldToWindowCoordinates` on a fixed ground point.
   - The X's must stay crisp, not smear into a bar.
9. **No loading flash:** delay the pattern image request by about 1.5 s. New shapes must show
   nothing, not a solid block, until the image loads, and it must appear without moving the
   camera (request-render mode).
10. **Build:** `npm run build` passes.

## Symptom → cause cheat sheet

| Symptom | Likely cause |
|---|---|
| "uniform has invalid type" | Passed a `Matrix4` instead of an array |
| Dark outline around strokes | Missing un-premultiply, or straight and premultiplied colors mixed in `over` |
| Moiré bands or solid hatch when zoomed out | `mipmapTexture` missing or not applied |
| Visible seam in the line pattern | Line image not `wrapS: REPEAT`, or not seamless |
| Speckled or broken X's far away | `metersPerPixel` taken from derivatives instead of `czm_metersPerPixel` |
| Hatch in blocks or streaks, or flat solid fill | Used the depth-based position instead of the ray-sphere intersection |
| Hatch moves with the screen at max zoom | Sphere not refit under the camera, or `cameraHigh` not wrapped with `mod` |
| X's smear into a bar at max zoom on long lines | Close-zoom reference-point path missing or wrong |
| Solid block flashes when a shape is created | Missing `textureSize <= 1` test |
| A new or swapped image only appears after moving the camera | `loadingImages` not tracked, or the caller doesn't request frames while it's non-empty |
| Torn X at a corner | Overflow pass missing, or `vertexFrames` not uploaded (size check `textureSize == (vertexCount, 4)` failing) |
| Stray bracket shape in a corner's wedge | `stampsAt(d, ...)` drawn where `pastOwnEnd` is true |
| Blocky stamp edges at a corner wedge | Wedge detected with screen-space derivatives instead of `pastOwnEnd` |
| X overhanging the line start with spacing < 1 | Missing `startGap` fade in `stampsAt` |
| Pattern stays half faded when the camera stops | Zoom settle missing, or its window doesn't match the shader's fade |
| Line pattern stretches when a vertex moves | Period derived from segment length instead of `2^k` meters |
| Shader fails to compile mentioning `step` | A local variable named `step` (a GLSL built-in) |
