# Implementation plan: ground-anchored pattern materials

This is a step-by-step plan for recreating this whole project from an empty folder: a CesiumJS +
Vite app for drawing ground-clamped polylines and polygons, and the two pattern materials it was
built to develop. The files, by step:

| step | files | what |
|---|---|---|
| 1 | `package.json`, `vite.config.js`, `.gitignore`, `index.html`, `src/style.css`, `public/patterns/*.svg`, `src/shared/testPatterns.js` | project scaffold, page, test images |
| 2 | `src/shared/mipmapTexture.js` | mipmaps and image-loading tracking |
| 3 | `src/shared/zoomSettle.js` | settles zoom fades when the camera stops |
| 4 | `src/shared/maxHeight.js` | max camera height math |
| 5 | `src/solutions/worldSpace/PolylinePatternMaterial.js` | line + stamp material |
| 6 | `src/solutions/worldSpace/PolygonPatternMaterial.js` | tiled fill material |
| 7 | `src/solutions/worldSpace/renderer.js`, `src/solutions/index.js` | turns shapes into primitives with the materials |
| 8 | `src/tools/DrawTool.js` | draws and edits shapes with the mouse |
| 9 | `src/main.js` | viewer, toolbar wiring, console helpers |
| 10 | — | verification |

Steps 2–6 are the **reusable part**: they depend only on `"cesium"` and each other, and can be
copied into another project. Steps 7–9 are the demo app that drives them; Step 7 is also the
reference for how any other project must use the materials. `README.md` and `docs/` are not part
of the build.

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
- Use plain JavaScript ES modules (no TypeScript, no framework), 2-space indentation and double
  quotes throughout.

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
      later through `material.maxHeight` and `material.heightTransition`. See Step 4.
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
  the GPU yet (Step 2). While it's non-empty, the caller must keep requesting frames, for
  example from `scene.postRender`.
- **Caller responsibilities** that the materials can't enforce. Step 7 does all of them; any
  other project using the materials must too:
  - Await `GroundPrimitive.initializeTerrainHeights()` once before creating ground primitives
    with `asynchronous: false`.
  - Give **each shape its own material**. Its uniforms (line length, vertex textures, origin
    frame) belong to one shape, so never share a material between primitives. Keep that material
    across rebuilds of the same shape.
  - Build the pattern polyline with `loop: false`. `setPositions` doesn't measure a closing
    segment.
  - Call `material.destroy()` when a shape is removed; removing the primitive doesn't do it.
  - Pin the Cesium version. `mipmapTexture` and the polyline material read the private
    `Material._textures` and `_loadedImages`, which a Cesium update may change.
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

- **Creating the material:** construct a Cesium `Material` from a fabric (a `type`, a
  `uniforms` object and a GLSL `source`) and mark it translucent.
  - `type` must be a unique string.
  - `source` is GLSL that defines Cesium's material entry point, `czm_getMaterial`, which takes
    a `czm_materialInput` and returns a `czm_material`.
  - Declare every uniform in the GLSL with the **same name** as its key in `uniforms`.
- **Changing uniforms at runtime:** assign to the property of that name on `material.uniforms`.
  - For vector uniforms (`Cartesian2/3/4`), **change the existing object's components in
    place** rather than assigning a new object. Material reads it by reference each frame.
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
  invalid type". Start it as a plain array of 16 numbers (the identity matrix, via
  `Matrix4.toArray`), and update it by packing the new matrix into that same array with
  `Matrix4.pack`.
- **Return value:** each `create()` returns the `Material` after passing it through
  `mipmapTexture` (Step 2), once per image uniform.

> ⚠️ The GLSL lives in a JavaScript template string, so **never put a backtick in a shader
> comment**. It ends the string and breaks the JS.

### Shader code shared by both materials

**Un-premultiply.** Browsers decode transparent SVG/PNG pixels as black; filtering blends that
black into stroke edges, giving a dark fringe. Every sample is un-premultiplied before it's
tinted: divide its RGB by its alpha (using at least 0.0001 as the alpha, to avoid dividing by
zero) and cap each channel at 1.

**Gamma.** The final color goes through Cesium's `czm_gammaCorrect`, and a fragment whose alpha
is below 0.005 is discarded.

**Placeholder.** Until an image loads, Cesium binds a 1×1 white placeholder texture, which
would render as a solid block. Check the texture's width with `textureSize`: if it's 1 pixel or
less, draw nothing for that image (the exact handling differs per material; see 5.3 and 6.3).

**Pixel size.** Cesium's `czm_metersPerPixel`, given an eye-space position, returns meters per
**CSS** pixel; it
already includes `czm_pixelRatio`. Line widths and tile sizes are also CSS pixels, so never
multiply sizes by `czm_pixelRatio`. It belongs only in explicit mip levels, which count device
pixels.

---

## Step 1 — Project scaffold, page and test images

### 1.1 Package and tooling

- Create `package.json` for a private ES-module package (`type` set to `module`) named
  `cesium-shaders`, version 0.1.0.
- Add three scripts: `dev` starts Vite's dev server, `build` makes a Vite production build, and
  `preview` serves that build.
- Dependency: `cesium` at `^1.122.0`. Dev dependencies: `vite` at `^5.4.10` and
  `vite-plugin-static-copy` at `^1.0.6`.
- Add an npm `overrides` entry pinning `@zip.js/zip.js`, a dependency of Cesium, to exactly
  `2.7.52`. It was in the original setup from the first commit; keep it.
- Run `npm install` and commit the resulting `package-lock.json`.
- Add a `.gitignore` that ignores `node_modules/` and `dist/`.

### 1.2 `vite.config.js`

Cesium loads its workers, imagery and widget styles from a base URL at runtime, so those files
must be served next to the app:

- Use `vite-plugin-static-copy` to copy four folders from `node_modules/cesium/Build/Cesium`
  (`ThirdParty`, `Workers`, `Assets` and `Widgets`) into a folder named `cesiumStatic` at the
  site root.
- Use Vite's `define` option to set the global `CESIUM_BASE_URL` to the string
  `/cesiumStatic`.

**Pitfall:** without the base URL and the copy, geometry workers and the offline Natural Earth
imagery return 404, and the globe stays blank.

### 1.3 `index.html`

A standard HTML5 page: `lang="en"`, UTF-8, a responsive viewport meta tag, the title
"Cesium Pattern Materials", a stylesheet link to `/src/style.css`, and `/src/main.js` loaded as
a module script at the end of the body.

The body holds a `div` with id `cesiumContainer` for the globe, then a `div` with id `toolbar`
containing, in this order:

1. An empty `div#solutionDescription`; Step 9 fills it.
2. Three buttons: `#btnPolyline` ("Draw Polyline"), `#btnPolygon` ("Draw Polygon") and
   `#btnClear` ("Clear").
3. A "Line width" label containing an empty `span#lineWidthValue`, for a range input
   `#lineWidth` from 2 to 96 in steps of 1.
4. A "Stamp spacing" label containing `span#stampSpacingValue`, for a range input
   `#stampSpacing` from −2 to 2 in steps of 0.01. The slider is logarithmic: value v means a
   multiplier of 2^v, so 0.25× to 4× with 1× in the middle. Say so in an HTML comment.
5. A "Max height" label containing `span#maxHeightValue` (its `for` points at the upper handle),
   then a `div#maxHeight` with class `dual-range` holding two range inputs, `#maxHeightLower`
   (aria-label "Transition start") and `#maxHeightUpper` (aria-label "Max height"), both from −3
   to 4.25 in steps of 0.01. Value v means 2^v "fit heights" (0.125× to 19×); the lower handle is
   where the transition starts, the upper one the max height, and the far right end means off.
   Say so in an HTML comment.
6. A `div` with class `row` holding two `div`s, each with a label and a select:
   - `#lineImage` ("Line image"): options None (value empty), Solid (`solid`, selected), Dashed
     (`dashed`), Wave (`wave`) and Sawtooth (`sawtooth`);
   - `#stampImage` ("Stamp image"): options None (value empty), X (`x`, selected) and Arrow
     (`arrow`).
7. A `div#hint` with the text "Pick a tool to start drawing."
8. An empty `div#cameraHeight`.

The three slider labels get the class `slider-label`. Step 9 looks every element up by its id,
so keep the ids exactly. The select values are the keys of `LINE_IMAGES` and `STAMP_IMAGES`
(1.6), and an empty value means no image.

### 1.4 `src/style.css`

- Start by importing Cesium's widget styles, `cesium/Build/Cesium/Widgets/widgets.css`.
- `html`, `body` and `#cesiumContainer` fill the window: 100% width and height, no margin or
  padding, overflow hidden, and the `system-ui, sans-serif` font.
- The toolbar floats over the globe: absolutely positioned 8px from the top-left, 8px padding,
  6px rounded corners, a dark translucent background (`rgba(42, 42, 42, 0.85)`), light text
  (`#eee`) and at most 360px wide.
- Buttons are dark (`#3a3a3a` with a `#666` border, rounded, a little spacing between them). A
  button with the class `active`, the tool being drawn, is blue (`#2d6cdf` with a `#6aa0ff`
  border).
- Labels are small (12px), grey (`#bbb`) and on their own line. The `.row` lays its two
  selects out side by side with an 8px gap, each taking half the width; the selects are
  full-width and styled like the buttons.
- The solution description and hint are small text. The value spans and `#cameraHeight` use a
  monospace font with tabular figures, so numbers don't jitter as they change. `#cameraHeight`
  has a thin top border separating it from the controls.
- The two plain sliders are full width.

The two-handle max height slider is two range inputs stacked on one track:

- The `.dual-range` container is positioned relatively, 20px tall, with a small bottom margin.
  It draws the track itself with a `::before` pseudo-element: a 4px tall grey (`#777`) bar with
  rounded ends, spanning the full width, 8px from the top.
- Both inputs are absolutely positioned to fill the container, with the native appearance
  removed, a transparent background and transparent tracks (style both the WebKit and Firefox
  track pseudo-elements), and pointer events turned **off**.
- The thumbs turn pointer events back **on**, so only the thumbs take the mouse and either
  handle can be dragged. They're round and blue (`#2d6cdf`) with a 2px `#eee` border and a
  pointer cursor: 14px in WebKit, 10px in Firefox. Style both `::-webkit-slider-thumb` and
  `::-moz-range-thumb`.
- The lower handle's thumb (the transition start) is a lighter blue (`#9bbcf5`), so the two can
  be told apart.

**Pitfall:** two stacked range inputs normally let only the top one receive the mouse. Turning
pointer events off on the inputs and on for the thumbs fixes that; Step 9 swaps their stacking
order when the thumbs coincide.

### 1.5 Test images, `public/patterns/`

White on transparent; the materials tint them. Vite serves `public/` at the site root, so they
load as `/patterns/<name>.svg`. Their sizes matter: each image is drawn as tall as the line is
wide, so the aspect ratio sets its length along the line.

The **line images** must be seamless (left and right edges join). The wave and sawtooth strokes
continue past the edges and are clipped by the viewBox, so the joins are exact.

`line-solid.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="128" viewBox="0 0 64 128">
  <rect x="0" y="58" width="64" height="12" fill="#ffffff" />
</svg>
```

`line-dashed.svg` (one dash and one gap; every segment starts with a dash):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect x="0" y="58" width="80" height="12" fill="#ffffff" />
</svg>
```

`line-wave.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128" viewBox="0 0 256 128">
  <path d="M -256 64 c 32 -44 96 -44 128 0 s 96 44 128 0 c 32 -44 96 -44 128 0 s 96 44 128 0
           c 32 -44 96 -44 128 0 s 96 44 128 0"
        fill="none" stroke="#ffffff" stroke-width="12" />
</svg>
```

`line-sawtooth.svg` (slow rise, sharp drop):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <polyline points="-128,96 -32,32 0,96 96,32 128,96 224,32 256,96"
            fill="none" stroke="#ffffff" stroke-width="12" stroke-linejoin="miter" />
</svg>
```

The **stamp images** are 256×128, so one stamp is twice the line width long, and at spacing 1
the symbols are one stamp length apart.

`x-symbol.svg` (a tall X, 56 wide × 104 tall, centred):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128" viewBox="0 0 256 128">
  <g stroke="#ffffff" stroke-width="14" stroke-linecap="round" fill="none">
    <line x1="100" y1="12" x2="156" y2="116" />
    <line x1="156" y1="12" x2="100" y2="116" />
  </g>
</svg>
```

`arrow-symbol.svg`: an arrowhead pointing along the direction of travel (+x), with a dot on one
side. It's asymmetric both ways, so it shows whether stamps keep their orientation along and
across the line, including past a vertex:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128" viewBox="0 0 256 128">
  <polyline points="100,20 156,64 100,108" fill="none" stroke="#ffffff" stroke-width="14"
            stroke-linecap="round" stroke-linejoin="round" />
  <circle cx="80" cy="28" r="10" fill="#ffffff" />
</svg>
```

`hatch-45.svg`, the **polygon tile**: a seamless 45° hatch. The main diagonal and the two
half-diagonals in the opposite corners line up across tile edges, and the lines extend past the
tile so their caps never show:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <g stroke="#ffffff" stroke-width="24" fill="none">
    <line x1="-32" y1="288" x2="288" y2="-32" />
    <line x1="-160" y1="160" x2="160" y2="-160" />
    <line x1="96" y1="416" x2="416" y2="96" />
  </g>
</svg>
```

### 1.6 `src/shared/testPatterns.js`

The demo's images and styling, used by Steps 7 and 9. It imports only `Color` from Cesium and
exports these constants:

| export | value |
|---|---|
| `LINE_IMAGES` | an object mapping `solid`, `dashed`, `wave` and `sawtooth` to `/patterns/line-solid.svg`, `/patterns/line-dashed.svg`, `/patterns/line-wave.svg` and `/patterns/line-sawtooth.svg` |
| `STAMP_IMAGES` | an object mapping `x` to `/patterns/x-symbol.svg` and `arrow` to `/patterns/arrow-symbol.svg` |
| `DEFAULT_LINE_IMAGE` | `"solid"` |
| `DEFAULT_STAMP_IMAGE` | `"x"` |
| `LINE_WIDTH` | 24 (pixels) |
| `LINE_COLOR`, `STAMP_COLOR` | both the CSS color `#ffd400` (yellow), converted with `Color.fromCssColorString` |
| `STAMP_SPACING` | 1 (stamp repeat as a multiple of the stamp length; 1 = touching) |
| `HATCH_URL` | `/patterns/hatch-45.svg` |
| `HATCH_TILE_PIXELS` | 48 (approximate tile size on screen) |
| `HATCH_COLOR` | the CSS color `#00e5ff` (cyan) |

Give each group a short comment saying what it's for.

---

## Step 2 — `src/shared/mipmapTexture.js`

**Why it's needed:** Cesium's Material uploads images **without mipmaps**. A 256 px tile drawn
at about 12 px then produces moiré bands, and the hatch can look solid. It also turns a loaded
image into a texture only on a *later* `update`, which in request-render mode may never come.

**Build:** a default-exported function `mipmapTexture(material, uniformName, options)` that
returns the material. `options` has `wrapS` and `wrapT`, both defaulting to
`TextureWrap.REPEAT`. It's called once per image uniform on the same material, so each call
wraps the previous one's `update`.

1. Keep a bound reference to the material's current `update` method, and a variable for the
   texture already mipmapped (initially none). Give the material a `loadingImages` set if it
   doesn't have one yet; all calls on one material share it.
2. Replace the material's `update(context)` with one that:
   1. calls the original `update` first;
   2. looks up the current texture for this uniform in the material's private `_textures` map
      (say in a comment that it's private Cesium API), and the uniform's current value;
   3. decides whether an image is set: the value is neither undefined, null, nor
      `Material.DefaultImageId`;
   4. checks whether a decoded image for this uniform is waiting in the material's private
      `_loadedImages` queue (an entry whose `id` is the uniform name). Material turns it into a
      texture on the next update; meanwhile the old texture, or the placeholder, is still bound;
   5. adds the uniform name to `loadingImages` if an image is queued, or if an image is set but
      there's no texture yet or the bound texture is the context's default (placeholder)
      texture. Otherwise removes the name;
   6. stops there if there's no texture, if it's the default texture, or if it's the texture
      already mipmapped;
   7. otherwise generates the texture's mipmaps, gives it a new `Sampler` with the requested
      wrap modes, trilinear minification (`LINEAR_MIPMAP_LINEAR`) and anisotropy 8, and
      remembers it as the mipmapped texture.
3. It imports `Material`, `Sampler`, `TextureMinificationFilter` and `TextureWrap` from Cesium.

**Pitfalls:**
- Don't replace the texture yourself, only its sampler.
- Don't generate mipmaps every frame. Remembering the mipmapped texture also handles an image
  swap: the new texture is a different object and gets its own mipmaps.
- Count a *queued* image as loading even though a texture is bound. During a swap the old
  texture stays bound until the next update; without this, the new image doesn't appear until
  the camera moves.

---

## Step 3 — `src/shared/zoomSettle.js`

**Why it's needed:** both materials pick a power-of-two scale from the zoom level and cross-fade
between two scales while the level's fractional part is inside a short **fade window**. A
camera that stops inside that window leaves the pattern half faded indefinitely. Once the camera
height stops changing, each layer therefore gets a small **level shift**, the same for every
pixel (so the fade just moves and no seam appears), animated until the screen centre leaves the
window by its nearest edge. While the height is changing, the shift stays put.

Constants: a rest delay of 150 ms (no height change for this long means the camera is at rest),
a speed of 0.3 levels per second, and a margin of 0.03 levels beyond the window edges (so nearby
pixels leave the window too).

### 3.1 `referenceMetersPerPixel(scene)` (exported)

Meters per CSS pixel on the ground at the screen centre, measured the way `czm_metersPerPixel`
measures it. Every material calls it, so compute it once per frame: cache the scene, the frame
number (`scene.frameState.frameNumber`) and the result in a module-level object, and return the
cached value when both match.

1. Take the centre of the canvas, in CSS pixels (half its client width and height).
2. Pick the ellipsoid point under it with the camera's `pickEllipsoid`, using the globe's
   ellipsoid.
3. The depth is the distance from the camera to that point measured along the camera's view
   direction (the dot product of the offset with the direction). If the centre shows sky and
   nothing was picked, use the camera's height instead.
4. Get the pixel dimensions at that depth (at least 1 mm) from the camera frustum's
   `getPixelDimensions`, passing the drawing buffer width and height and the scene's pixel
   ratio.
5. Return the pixel's height, but at least 1e-9.

### 3.2 `createZoomSettle()` (exported)

Returns a fresh state object, one per material: no height yet, last change at minus infinity, no
last frame time, and an empty object of shifts.

### 3.3 `updateZoomSettle(state, scene, layers)` (exported)

`layers` maps each layer name to its `level` (the zoom level at the screen centre, the log2 of
the pattern's size in meters) and its `window` (the start and end of the range of the level's
fractional part where the layer is partly faded; the end may exceed 1). It returns the state's
shifts, by layer name.

1. Read the current time (`performance.now()`) and camera height. If a previous height is
   stored and the height changed by more than a millionth of itself, record now as the last
   change. Store the height.
2. It's the first frame if no last frame time is stored. The time step is 0 on the first frame,
   otherwise the seconds since the last frame, **capped at 0.1 s**. The cap matters: frames
   stop while idle, so the gap after a pause can be seconds. Store now as the last frame time.
3. The camera is resting if the last change was at least the rest delay ago. Start with
   "settling" set to the opposite of resting, so frames keep coming until the rest is noticed.
4. For each layer, start from its stored shift (0 if none). If resting, compute the target
   shift (`settledShift`, below). On the first frame jump straight to the target; otherwise move
   towards it by at most the speed times the time step. If the shift hasn't reached the target,
   it's still settling. Store the shift.
5. If still settling, request a render.

Helpers:

- **`windowPosition(level, window)`**: the window is widened by the margin on both sides. Its
  length is the window's end minus its start plus twice the margin. Take the level minus the
  widened window's start, and its fractional part f. Return f if it's strictly between 0 and the
  length, otherwise −1 (outside the window).
- **`settledShift(level, shift, window)`**: if the level plus the current shift is already
  outside the window, keep the current shift. Otherwise find where the **unshifted** level lies
  in the window; if it's outside, return 0. If it's inside at position f, there are two exits:
  down by f (a shift of −f) or up by the length minus f. Return whichever is closer to the
  current shift (down on a tie). This keeps shifts smaller than one window.
- **`approach(value, target, maxStep)`**: return the target if it's within `maxStep`, otherwise
  move the value `maxStep` towards it.

**Pitfalls:**
- The shift must be added to the shader's level for **every pixel alike**, as a uniform. A
  per-pixel correction would create a seam.
- Don't move the shift while the camera height is changing. Fades must follow the zoom
  smoothly; only a resting camera is corrected.
- Keep the current shift if it already works (`settledShift`'s first test). Otherwise a small
  zoom would snap the shift back to 0 and make the pattern jump.

---

## Step 4 — `src/shared/maxHeight.js`

**Why it's needed:** patterns keep a near-constant on-screen size by scaling with the camera
height. Above a **max height** they should stop scaling and keep their ground size instead,
shrinking on screen like paint, easing in over a transition below it.

### 4.1 `sizeScale(height, maxHeight, transition)` (exported)

Returns the factor, between 0 and 1, that the materials multiply their meters-per-pixel by: the
"effective height" divided by the actual height h. With H the max height and T the transition
clamped to between 0 and H, the effective height is:

- **h itself**, at or below H − T;
- **h − (h − (H − T))² / (2T)** between H − T and H, so the slope eases from 1 to 0;
- **H − T/2** at or above H, so the size is frozen.

Return 1 if the max height isn't finite or the height isn't positive. Otherwise return the
effective height divided by h, capped at 1. With T = 0 this is a hard cap at H.

### 4.2 `boundingBoxDiagonal(positions)` (exported)

The ground length of the diagonal of the positions' longitude/latitude box: build the box with
`Rectangle.fromCartesianArray`, then return the surface distance of an `EllipsoidGeodesic` from
its southwest to its northeast corner. Return 0 for fewer than two positions or when the box has
neither width nor height.

### 4.3 `fitMaxHeight(diagonal, camera, factor, easeFrom)` (exported)

The max height for a shape, in units of its **fit height**: the camera height at which the
diagonal just fills the view vertically, looking straight down. Returns a `maxHeight` and a
`heightTransition`.

- If the diagonal isn't positive or the factor isn't finite, return an infinite max height and a
  transition of 0.
- The fit height is the diagonal divided by twice the tangent of half the camera frustum's
  vertical field of view (`fovy`; use π/3 if the frustum has none).
- The max height is the factor times the fit height.
- The transition starts at `easeFrom` (clamped to between 0 and the factor) times the fit
  height; the transition is the max height minus that start.

The materials only use `sizeScale`. `boundingBoxDiagonal` and `fitMaxHeight` are for the
caller, which sets `material.maxHeight` and `material.heightTransition` per shape every frame
(it depends on the field of view).

---

## Step 5 — `src/solutions/worldSpace/PolylinePatternMaterial.js`

### 5.1 Behaviour to achieve

Two optional layers, both drawn as tall as the line is wide, so each image keeps its aspect
ratio:

**Line layer.** A seamless pattern repeated along the line, anchored to the ground and to the
line's start.
- The period is 2^k meters, with k chosen per fragment so the period is 1×–2× the image's
  natural length (line width × image width / image height). It depends only on zoom, so moving
  a vertex never stretches it.
- Just before the period doubles, the pattern is nearly 2× stretched; it cross-fades to half
  the period there, while the level's fractional part is between 0 and 0.2.
- It runs on across vertices. In the mitered wedge outside a corner, `GroundPolylinePrimitive`
  clamps `st.s` to the vertex, so the wedge shows the image column at the vertex. For a solid
  line that's a clean miter join.

**Stamp layer.** Symbols drawn on top at a near-constant pixel size, anchored to the line.
- The repeat length is the stamp length × `spacing`. `spacing` defaults to 1 (touching) and is
  never taken below a minimum of 0.25 (overlapping). Above 1, more line shows between stamps.
- Stamp centres are 2^k meters apart, with k chosen per fragment so the spacing is 1–2× the
  repeat length. Every second stamp fades out while the level's fractional part is between 0.9
  and 1, so nothing pops when k changes. The stamp is never stretched.
- The grid starts at the first vertex: the first stamp's leading edge touches it at every zoom.
  It runs to the last vertex, which cuts off the final stamp.
- **Each stamp belongs to the segment containing its centre** and is drawn in that segment's
  direction, also where it reaches past an interior vertex. Near a vertex, each pixel also
  draws the other segment's stamps, measured in that segment's frame from per-vertex frames
  (eye-space position, incoming and outgoing direction, up) that the CPU uploads every frame. A
  stamp over a corner is therefore whole, never torn.
- Stamps are only visible inside the line's footprint (the draped bands plus the corner
  wedges), so symbols taller than the line width are clipped.

**Max height.** Above it (size scale below 1) both layers keep their ground size. The geometry
stays `v_width` pixels wide, so the pattern is drawn in a centred band `v_width` × size scale
pixels wide, and the line looks thinner.

**Inputs from `GroundPolylinePrimitive`:**
- `materialInput.st.s` is the arc length along the **whole** line, normalized to 0..1.
- `materialInput.st.t` is the position across the width, 0..1.
- `v_width` is the line width in CSS pixels. Cesium only provides it when the material source
  contains the exact declaration `in float v_width;`.

### 5.2 Uniforms

| name | JS initial value | meaning |
|---|---|---|
| `lineImage`, `stampImage` | the option, or `Material.DefaultImageId` for `null` | 1×1 placeholder = layer off |
| `lineColor`, `stampColor` | `Color.WHITE` default | tints |
| `spacing` | `1` default | stamp repeat as a multiple of the stamp length; never taken below the minimum spacing, 0.25 (a constant in both the GLSL and the JS, kept in sync) |
| `lineShift`, `stampShift` | `0` | zoom settle level shifts (Step 3) |
| `sizeScale` | `1` | max height factor (Step 4) |
| `lineLength` | `1` | geodesic length of the line in meters (set by `setPositions`) |
| `preciseMetersPerPixel` | `0` | switch-over threshold for the close-zoom path |
| `referenceA`, `referenceB` | `new Cartesian4()` | xyz: point on the line in eye coordinates; w: distance along the line modulo the modulus (5.5) |
| `tangentA`, `tangentB` | `new Cartesian4()` | xyz: unit line direction in eye coordinates; w: 1 if valid, else 0 |
| `rangeA`, `rangeB` | `new Cartesian2()` | distance along the line from that reference point to its segment's start (x, ≤ 0) and end (y, ≥ 0) |
| `lineEndsA`, `lineEndsB` | `new Cartesian2()` | that reference's segment: x = 1 if it starts the line, y = 1 if it ends it |
| `vertexDistances` | `Material.DefaultImageId` | float data texture, one texel per vertex in a single row: distance along the line of each vertex, ascending, both ends included |
| `vertexCount` | `0` | number of texels in `vertexDistances` |
| `vertexFrames` | `Material.DefaultImageId` | float data texture, one column per vertex and 4 rows, eye coordinates. Row 0: position, with w = 1 if the vertex is interior. Rows 1, 2, 3: incoming direction, outgoing direction, up. Re-uploaded every frame. |
| `nearVertex` | `new Cartesian4()` | close-zoom path: the interior vertex nearest the camera. xyz: eye position; w: 0 = none, otherwise 1, plus 2 if the segment before it starts the line, plus 4 if the segment after it ends the line |
| `nearIncoming`, `nearOutgoing` | `new Cartesian4()` | xyz: its incoming / outgoing direction; w: length of the segment before / after |
| `nearUp` | `new Cartesian4()` | xyz: its up; w: its distance along the line modulo the modulus |

The material's `TYPE` is `"PolylinePatternWorld"`. In `create()`:
- give the material empty `segments` and `vertices` arrays, and no pending vertex distances or
  vertex frames;
- give it CPU-side copies used only by `updateCamera`: a `lineWidth` of 1, and `lineAspect` and
  `stampAspect` from a helper `imageAspect`. That helper returns width / height for an image
  (natural size) or canvas, and 1 for `null` or a URL that hasn't loaded;
- give it a zoom settle state (Step 3) and its `maxHeight` and `heightTransition`;
- wrap its `update` method **before** calling `mipmapTexture`, because creating data textures
  needs the WebGL context, which only `update(context)` receives. The wrapper:
  1. if vertex distances are pending, creates a new `vertexDistances` data texture holding one
     distance per texel (in the red channel), sets `vertexCount` to their number, and clears
     the pending distances;
  2. if vertex frames are pending: when the current `vertexFrames` uniform is already a
     `Texture` of the same width and 4 rows high, copies the new data into it; otherwise creates
     a new data texture from the data. Then clears the pending frames;
  3. calls the original `update`;
  4. for each image uniform, if its texture in the private `_textures` map exists, isn't the
     context's default texture and has a height, sets `lineAspect` or `stampAspect` from that
     texture's width / height. This catches images given as URLs once they've loaded.
- add a helper `createDataTexture(context, width, height, fill)`: it allocates a float array of
  width × height × 4 values, lets `fill` write into it, and returns a `Texture` of that size
  with RGBA float pixels, no Y flip, and a sampler that clamps to the edge and uses nearest
  filtering. Rows are stored one after another, so texel (x, y) starts at index
  (y × width + x) × 4;
- finally, call `mipmapTexture` for `lineImage` with wrapS `REPEAT` and wrapT `CLAMP_TO_EDGE`,
  then return the result of calling it for `stampImage` with both wraps `CLAMP_TO_EDGE`.

`setImages(material, { lineImage, stampImage })`: for each image that isn't `undefined`, set
the uniform to the image, or to `Material.DefaultImageId` when it's `null`, and refresh
`lineAspect` / `stampAspect` with `imageAspect`.

> ⚠️ The line image needs wrapS `REPEAT`: it's sampled at the fractional part of its phase,
> and filtering must wrap across the seam. Stamps need `CLAMP_TO_EDGE` so their edges don't
> bleed in from the opposite side.

### 5.3 Fragment shader

The source starts with the exact declaration `in float v_width;`, then the constant minimum
spacing (0.25), then every uniform from 5.2. Then these helper functions:

- **`vertexDistanceAt(i)`**: fetches texel i of row 0 of `vertexDistances` exactly (with
  `texelFetch`) and returns its red channel.
- **`segmentIndex(c)`**: the index i of the segment from vertex i to vertex i + 1 that contains
  distance c, clamped to the first or last segment. Binary search with low = 0 and high =
  vertex count − 1: while high − low is more than 1, look at the middle index; if its distance
  is at most c, move low there, otherwise move high there. Return low. Loop at most 32 times
  (GLSL needs a fixed bound). Requires at least two vertices.
- **`tinted(sample, tint)`**: un-premultiplies the sample (section 0), multiplies its RGB back
  by its alpha (premultiplied again, now without the dark fringe), multiplies the RGB by the
  tint's RGB, and multiplies the whole color by the tint's alpha. The result is premultiplied.
- **`over(top, bottom)`**: premultiplied "over" compositing: top plus bottom × (1 − top's
  alpha).
- **`lineAt(along, t, widthPixels, metersPerPixel)`**, the line layer at `along` meters along
  the line and `t` across it, for a band `widthPixels` wide:
  1. Return transparent if t is not strictly between 0 and 1.
  2. The natural period in meters is widthPixels × image width / image height × metersPerPixel.
  3. The level is log2 of the natural period plus `lineShift`. k is the level rounded **up**.
     The blend is a smoothstep from 0.8 to 1.0 of k − level, so the layer is partly faded while
     the level's fractional part is between 0 and 0.2.
  4. The period is 2^k meters, anchored at the start of the line (distance 0). The phase is
     along / period.
  5. The explicit mip level is log2(image width × metersPerPixel / (period × `czm_pixelRatio`)),
     but at least 0.
  6. Take a "coarse" sample at (fractional part of phase, t) at that mip level, and a "fine"
     sample at (fractional part of 2 × phase, t) one mip level coarser, both with `textureLod`.
  7. Mix coarse towards fine by the blend, and return it `tinted` with `lineColor`.
- **`stampsAt(along, t, a, b, lineEnds, gridSpacing, fadeOut, stampMeters, lod)`**, the stamps of
  the segment from distance a to b, at `along` meters along the line and `t` across it.
  `lineEnds` x is 1 if the segment starts the line and y is 1 if it ends it.
  1. Return transparent if t is not strictly between 0 and 1.
  2. Stamp centres are at origin + i × gridSpacing, where the origin is half a stamp length, so
     the first stamp's leading edge is at distance 0. The segment owns the stamps whose centre
     lies in [a, b): the first index is (a − origin) / gridSpacing rounded up, and the last is
     (b − origin) / gridSpacing rounded up, minus 1.
  3. If the segment ends the line, it also owns stamps that start before its end but are
     centred beyond it, so the pattern runs to the last vertex, which cuts the final stamp off:
     the last index is instead (b + half a stamp − origin) / gridSpacing rounded up, minus 1.
  4. Return transparent if the first index is greater than the last.
  5. The nearest stamp index is (along − origin) / gridSpacing rounded to the nearest integer,
     clamped to the first and last index. Consider it and two neighbours on either side (for
     spacing below 1, where stamps overlap), skipping indices outside first..last.
  6. For each index i: the centre is origin + i × gridSpacing, and u = 0.5 + (along − centre) /
     stampMeters. Skip it unless u is strictly between 0 and 1.
  7. Its opacity ("keep") is 1 for even i, and 1 − fadeOut for odd i (the zoom-level fade).
  8. If the segment starts the line, also multiply keep by a smoothstep from 0.9 to 1.0 half
     stamps of the gap between the centre and a. Stamps then can't overhang the first vertex
     (with spacing below 1, the grid has stamps before its first whole one), while one exactly
     touching it stays whole. If the segment doesn't start the line, there's no such fade.
  9. If keep is above 0, sample the stamp image at (u, t) with `textureLod` at the given mip
     level, tint it with `stampColor`, multiply it by keep, and composite it `over` the result
     so far.
  10. Return the result.

Then `czm_getMaterial` does the following, in order:

1. **Start** from Cesium's default material for the input.
2. **Which layers:** a layer is present if its texture is wider than 1 pixel (a null or loading
   image is the 1×1 placeholder). Discard the fragment if neither is present.
3. **Distance along the line:** d = `st.s` × `lineLength`.
4. **Pixel size at this fragment**, computed the way `GroundPolylinePrimitive` sizes its width:
   read the globe depth at this fragment from `czm_globeDepthTexture` (texture coordinates are
   the fragment coordinate divided by the viewport size) and unpack it with `czm_unpackDepth`;
   turn the fragment coordinate and that depth into an eye-space position with
   `czm_windowToEyeCoordinates` and divide by its w. metersPerPixel is `czm_metersPerPixel` of
   that position, at least 1e-6. It's per CSS pixel, the same units as `v_width`.
5. **Max height band:** bandPixels is `v_width` × `sizeScale`, but at least 1 pixel and at most
   `v_width`. coverage is `v_width` × `sizeScale` / bandPixels (below 1 only when the band would
   be thinner than a pixel; it then fades instead of aliasing). The band width on the ground,
   width, is bandPixels × metersPerPixel.
6. **Close-zoom precision path** (see 5.5). If metersPerPixel is below `preciseMetersPerPixel`
   and reference A is valid (`tangentA` w above 0.5):
   - For each reference, take the offset from its point to the fragment's eye position, its
     component along the reference's tangent ("along"), and the length of the rest
     ("off", the distance from the line). Reference B's off is huge if B isn't valid.
   - Use A if its off is at most B's, otherwise B. Then d becomes that reference's w plus its
     along; the segment's ends are its w plus its range; and the line-ends flags are its
     `lineEnds`.
7. **The segment this fragment is on:** by default it runs from 0 to `lineLength` with both
   line-ends flags set, and its index is 0. In the precise path, use the values from step 6.
   Otherwise, if there are at least two vertices, find the index with `segmentIndex(d)`, take
   its ends from `vertexDistanceAt` of that index and the next, and set the flags: it starts the
   line if the index is 0, and ends it if index + 2 reaches the vertex count.
8. **Across the band:** t = (`st.t` − 0.5) × `v_width` / bandPixels + 0.5, so 0..1 spans the
   centred band.
9. **Line layer:** if present, the result is `lineAt` at d clamped to the segment's ends, with
   t, bandPixels and metersPerPixel. Otherwise the result starts transparent.
10. **Stamp layer**, if present:
    1. stampMeters is width × stamp image width / height. The repeat is stampMeters ×
       `spacing` (at least the minimum spacing). The level is log2 of the repeat plus
       `stampShift`; k is the level rounded **up**, not down; gridSpacing is 2^k meters (1×–2×
       a repeat). fadeOut is a smoothstep from 0.9 to 1.0 of 1 − (k − level). The mip level is
       log2(stamp image width × metersPerPixel / (stampMeters × `czm_pixelRatio`)), at least 0.
    2. **The nearest interior vertex.** Start with no vertex, and defaults: position zero,
       incoming and outgoing along x, up along z, distance dv 0, segment lengths before and
       after 0, and both "segment starts / ends the line" flags false.
       - In the precise path, if `nearVertex` w is above 0.5, use `nearVertex` and its
         companions: position from `nearVertex`, directions from `nearIncoming`, `nearOutgoing`
         and `nearUp`, dv from `nearUp` w, the lengths before and after from the w of
         `nearIncoming` and `nearOutgoing`, and the flags from bits 2 and 4 of `nearVertex` w
         (test them by dividing by 2 or 4, rounding down, and checking whether the result is
         odd).
       - Otherwise, if there are at least two vertices **and** the `vertexFrames` texture's size
         is exactly (vertex count, 4) (it may not be uploaded yet), take whichever end of the
         current segment is closer to d. Fetch its row 0; if its w is above 0.5 (interior), use
         it: position from row 0, incoming, outgoing and up from rows 1–3, dv from
         `vertexDistanceAt`, the lengths before and after from the neighbouring vertices'
         distances, "before starts the line" if its index is 1, and "after ends the line" if its
         index + 2 reaches the vertex count.
    3. **Past the vertex?** Take the offset from the vertex position to the fragment's eye
       position. The vertex is at the segment's end if dv is at least as close to the segment's
       end as to its start. The fragment is **past its own segment's end** (`pastOwnEnd`) if
       there is a vertex and, for a vertex at the end, the offset points forward along the
       incoming direction (positive dot product), or, for a vertex at the start, backward
       against the outgoing direction (negative dot product). There `st.s` is clamped, so d
       can't place stamps; this per-pixel test is exact.
    4. **This segment's stamps:** unless past its own end, composite `stampsAt` at d, with t,
       the segment's ends and flags, gridSpacing, fadeOut, stampMeters and the mip level, over
       the result.
    5. **Stamps reaching across the vertex:** if there is a vertex and the fragment is past its
       own end or within reach of the vertex (|d − dv| below half a stamp plus width):
       - if past its own end, or the vertex is at the segment's start, draw the **incoming**
         segment's stamps measured in its frame: along = dv + the offset's component along the
         incoming direction; across = 0.5 + the offset's component along the normalized cross
         product of incoming and up, divided by width. Composite `stampsAt` with those, the
         segment from dv − length before to dv, flags (before starts the line, false), and the
         same grid, fade, stamp length and mip level;
       - if past its own end, or the vertex is at the segment's end, do the same for the
         **outgoing** segment: along and across from the outgoing direction, the segment from dv
         to dv + length after, flags (false, after ends the line).
11. **Finish:** multiply the result by coverage. Discard if its alpha is below 0.005.
    Un-premultiply (divide RGB by alpha), gamma-correct with `czm_gammaCorrect`, and write the
    RGB to the material's **emission** (not diffuse: the line is unlit) and the alpha to its
    alpha. Return the material.

**Pitfalls:**
- **Don't** get metersPerPixel from screen-space derivatives (`dFdx`/`dFdy`) of d. d comes from
  the depth buffer, and its derivatives are noisy, which makes the X's speckled and broken. Use
  `czm_metersPerPixel` of the reconstructed eye position.
- **Don't** use plain `texture()` for either image. The stamp's u jumps between stamps and the
  line phase wraps, so automatic mip selection breaks. Use `textureLod` with the explicit mip
  levels given (the line's fine sample is one level coarser).
- **Don't** multiply sizes by `czm_pixelRatio` (see "Pixel size" in section 0). It belongs only
  in the mip levels.
- Divide by stampMeters, not the repeat length, when computing u. Otherwise `spacing` stretches
  the stamp instead of adding a gap.
- Skip stamps whose u is not strictly between 0 and 1; clamped samples there would draw the
  stamp's edge column.
- Composite in **premultiplied** alpha (`tinted` then `over`) and un-premultiply once at the
  end. Mixing straight and premultiplied colors darkens overlaps.
- **Don't** detect the wedge with screen-space derivatives of `st.s`. That misclassifies whole
  2×2 pixel quads at the wedge edge. Use the per-pixel `pastOwnEnd` test against the vertex
  frame.
- In the wedge, don't draw `stampsAt` at d: d is clamped to the vertex there, and every pixel
  would read the same stamp column, smearing it into a bracket.
- The line layer gets d clamped to the segment's ends, so in the close-zoom path the wedge also
  shows the column at the vertex.
- Decide whether a stamp is drawn **per stamp**, from its centre, not per fragment. Otherwise
  part of an X disappears and the rest stays.
- The material is inserted **before** Cesium's own polyline shader code. Don't try to read
  Cesium's varyings such as `v_endEcAndStartEcX`: redeclaring them is a GLSL error.
- Never name a local variable `step`; it's a GLSL built-in.

### 5.4 `setPositions(material, positions, width)` (CPU)

Store the width as the material's `lineWidth`. Then, for each consecutive pair of positions:

1. Build an `EllipsoidGeodesic` between them (converted to cartographic on the WGS84
   ellipsoid).
2. Read its surface distance as the segment length, and skip the pair if the length isn't
   positive.
3. Add a segment record to `material.segments` with its index in that array, the geodesic, its
   length, its start (the running total of the previous segments' lengths), and the two
   positions normalized to unit vectors (`a` and `b`).

Then set the `lineLength` uniform to the total length (at least 1 mm), compute the vertices with
`computeVertices` (below), and set the pending vertex distances to each vertex's distance. The
wrapped `update` uploads them on the next frame.

`computeVertices(segments)` returns an empty array when there are no segments, otherwise one
entry per vertex (one more than the number of segments), in world coordinates. For vertex i,
"before" is segment i − 1 and "after" is segment i (either may not exist):
- **position:** the start of "after", or for the last vertex the end of "before" (using
  `pointAt`, 5.6);
- **incoming:** the direction at the end of "before"; **outgoing:** the direction at the start
  of "after". At an end of the line, use whichever exists for both. The direction at a fraction
  f (`directionAt`) is the normalized difference between the points at f + δ and f − δ, with δ =
  1 / segment length (about 1 m) but at most 0.5, and both fractions clamped to 0..1;
- **up:** the WGS84 surface normal at the position;
- **distance:** the start of "after", or for the last vertex the start plus length of "before";
- **interior:** true when both "before" and "after" exist.

> `lineLength` must be the geodesic length. Cesium normalizes `st.s` by the line's arc length,
> and a wrong length stretches the images.

### 5.5 `updateCamera(material, scene)` (CPU, double precision)

**Why the precision part is needed:** `st.s` is a 32-bit float, so d only resolves to
`lineLength` × 2^−24. That's 22 cm on a 3,600 km line, which smears the X's into a bar at 1 m
zoom. Close up, the shader therefore measures distance from reference points that the CPU
computes exactly.

1. **Max height:** set the `sizeScale` uniform with `sizeScale` (Step 4) from the camera's
   height, the material's `maxHeight` and its `heightTransition`.
2. **Zoom settle.** In CSS pixels, like the shader: the stamp repeat in pixels is the line width
   × the stamp aspect × the spacing (at least the minimum spacing); the line period in pixels is
   the line width × the line aspect. The meters per pixel is `referenceMetersPerPixel` (Step 3)
   times the size scale. Call `updateZoomSettle` with two layers:
   - `line`: level log2(line pixels × meters per pixel), window 0 to 0.2;
   - `stamp`: level log2(stamp pixels × meters per pixel), window 0.9 to 1.

   Store the returned shifts in `lineShift` and `stampShift`. The windows must match the
   shader's fades.
3. **Threshold and modulus:**
   - the float step is `lineLength` × 2^−24, and `preciseMetersPerPixel` is that step × 64;
   - the largest spacing used near the camera is 4 × the larger of the stamp and line pixel
     lengths × `preciseMetersPerPixel`;
   - the **modulus** is the smallest power of two at least twice that (and at least 1 mm).

   Stamp spacing stays under 4 repeat lengths, and the line period under 4 image lengths (2×,
   plus the level shift). A power-of-two modulus of at least twice that keeps the stamp-index
   parity (odd/even fade) and the line phase consistent. It reads `spacing` every frame, so
   changing the uniform at runtime is safe.
4. For each segment, find the nearest point to the camera position with
   `nearestPointOnSegment` (5.6), and keep the **two** segments with the smallest distance,
   each with its nearest-point result. Two are needed so corners near the camera work.
5. Fill reference A from the nearest and reference B from the second nearest with
   `setReference`, which writes into the existing uniform objects:
   - if there's no candidate, set the tangent's w to 0 and stop;
   - the line-ends flags: x is 1 if it's the first segment, y is 1 if it's the last;
   - the range: x is −fraction × segment length, y is (1 − fraction) × segment length;
   - the reference point is the nearest point transformed by the camera's view matrix (eye
     coordinates), with w = the distance along the line (segment start + fraction × length)
     modulo the modulus;
   - the tangent is the nearest point's direction transformed by the view matrix **as a
     vector** and normalized, with w = 1.
6. **Vertex frames** (`updateVertexFrames`):
   1. Set `nearVertex` w to 0; stop if there are no vertices.
   2. Reuse a float array stored on the material, with 16 values per vertex (4 rows × RGBA);
      allocate a new one only when the vertex count changes.
   3. For each vertex v, write in eye coordinates: in row 0, its position transformed by the
      view matrix, with w = 1 if interior else 0; in rows 1, 2 and 3, its incoming direction,
      outgoing direction and up transformed by the view matrix as vectors, with w = 0.
   4. Of the interior vertices, find the one nearest the camera (the smallest eye-space
      position length, since the camera is the eye-space origin). Copy it into the close-zoom
      uniforms:
      - `nearVertex`: its eye position, with w = 1, plus 2 if v is 1, plus 4 if v is the
        second-to-last vertex;
      - `nearIncoming`: its incoming direction in eye coordinates, with w = its distance minus
        the previous vertex's distance;
      - `nearOutgoing`: its outgoing direction in eye coordinates, with w = the next vertex's
        distance minus its distance;
      - `nearUp`: its up in eye coordinates, with w = its distance modulo the modulus.
   5. Set the pending vertex frames to the width and the array; the wrapped `update` uploads
      them.

   This runs every frame because eye coordinates change with the camera. They're computed in
   double precision on the CPU, so they stay precise at close zoom.

### 5.6 `nearestPointOnSegment(segment, position)` (CPU)

1. **Great-circle first guess:** normalize the position. Take the unit normal of the plane
   through the segment's two unit vectors (their normalized cross product), and project the
   position onto that plane. The angle from `a` to the projection is the two-argument
   arctangent of (the cross product of `a` and the projection, dotted with the normal) and (`a`
   dotted with the projection). The starting fraction is that angle divided by the angle
   between `a` and `b`, clamped to 0..1, or 0 if the segment's angle is 0.
2. **Refine on the real geodesic**, three times: take the point and direction at the fraction,
   and move the fraction by the offset from that point to the position, dotted with the
   direction, divided by the segment length, clamping to 0..1. After the last iteration,
   recompute the point and direction at the final fraction.
3. **`pointAt(segment, fraction)`:** clamp the fraction to 0..1, interpolate the geodesic at
   that fraction (`interpolateUsingFraction`), set the height to 0, and convert to Cartesian on
   the WGS84 ellipsoid.
4. Return the point, the direction (as `tangent`), the fraction and the distance from the
   position to the point.

Use module-level scratch objects for temporary vectors. Allocate **new** objects for the
returned point and direction, and for each vertex's fields.

---

## Step 6 — `src/solutions/worldSpace/PolygonPatternMaterial.js`

### 6.1 Behaviour to achieve

**The tile image** is a seamless 256×256 45° hatch. It fills the draped polygon as follows:

- **Anchoring:** the hatch is pinned to the ground, with square tiles aligned to east/north at
  the polygon's center.
- **Size:** tiles are about 0.7×–1.4× `tileSize` pixels on screen at every zoom. The tile is
  2^k meters, and over the last 20% of a level the shader cross-fades to 2^(k+1).
- **Max height:** above it, the tile keeps its ground size.

**Approach:**
- **Don't** use `materialInput.st`.
- **Don't** use `positionToEyeEC` as the position. On a `GroundPrimitive` it comes from the depth
  buffer, which is too coarse: the hatch turns into blocks or a flat solid fill.
- Use only its **direction**, and intersect that view ray with a sphere fitted under the camera.

### 6.2 Uniforms

| name | JS initial value | meaning |
|---|---|---|
| `image`, `color` | from options (`Color.WHITE` default) | |
| `tileSize` | `48` default | target tile size in CSS pixels |
| `eyeToLocal` | identity matrix as a 16-number **array** (not a `Matrix4`) | eye coordinates → polygon east/north/up frame |
| `radius` | `Ellipsoid.WGS84.maximumRadius` | radius of the sphere under the camera |
| `cameraHeight` | `1` | camera height above that sphere (m) |
| `cameraUp` | `new Cartesian3(0, 0, 1)` | unit vector, sphere center → camera, local frame |
| `cameraHigh`, `cameraLow` | `new Cartesian2()` | camera east/north = high + low (float split) |
| `levelShift` | `0` | zoom settle level shift (Step 3) |
| `sizeScale` | `1` | max height factor (Step 4) |

The material's `TYPE` is `"PolygonPatternWorld"`. In `create()`:
- give the material `localToWorld` and `worldToLocal` matrices, both starting as identity;
- give it a zoom settle state (Step 3), its `maxHeight` (default infinity) and its
  `heightTransition` (default 0);
- return it passed through `mipmapTexture` for `image`, with the default `REPEAT` wraps; the
  tiling depends on them.

### 6.3 Fragment shader

`czm_getMaterial` does the following, in order:

1. **Placeholder:** if the image texture is 1 pixel wide or less, discard; draw nothing until
   the real image is there.
2. **View ray:** the eye-space direction is the normalized negative of `positionToEyeEC` (the
   direction only). Transform it into the local frame with the rotation part (upper-left 3×3)
   of `eyeToLocal`, and normalize.
3. **Ray-sphere intersection,** cancellation-free. With the direction d, let b = (`radius` +
   `cameraHeight`) × (`cameraUp` · d) and c = `cameraHeight` × (`cameraHeight` + 2 × `radius`).
   The near root is t = c / (−b + √max(b² − c, 0)). This is the same root as the usual
   −b − √(b² − c), rewritten to avoid subtracting nearly equal numbers.
4. **Ground point:** p = `cameraLow` + t × (the x and y of the local direction); these are
   meters east/north, minus `cameraHigh`. Take p's screen-space derivatives in x and y (`dFdx`,
   `dFdy`); they're smooth. metersPerPixel is `czm_metersPerPixel` at the eye-space position
   direction × t (with w = 1), at least 1e-6.
5. **Tile scale:** the level is log2(`tileSize` × metersPerPixel × `sizeScale`) + 0.5 +
   `levelShift`. The +0.5 centres the tile on `tileSize` (0.7×–1.4×). k is the level rounded
   **down** (this cross-fade is between k and k + 1). The blend is a smoothstep from 0.8 to 1.0
   of the level's fractional part. The two tile sizes are 2^k and twice that.
6. **Texture coordinates:** for each size, the coordinate is (`cameraHigh` modulo the size, plus
   p) divided by the size.
7. **Samples:** sample the image at each coordinate with `textureGrad`, passing p's derivatives
   divided by that size, and mix the two samples by the blend.
8. **Finish:** un-premultiply (section 0), multiply by `color`, discard if the alpha is below
   0.005, gamma-correct with `czm_gammaCorrect`, and write the RGB to the material's
   **diffuse** (the appearance is flat) and the alpha to its alpha. Return the material.

**Pitfalls:**
- **Don't** compute c from the camera's local position as its squared length plus 2 × radius
  × its height component. That suffers catastrophic float cancellation. Use h × (h + 2R) with
  h computed on the CPU.
- **Don't** add `cameraHigh` to p directly. That loses about 6 cm of precision when the camera
  is 1,000 km from the origin, and the pattern stutters while panning. Wrap it first, modulo the
  tile size, which is exact because the size is a power of two.
- Use `textureGrad` with the derivatives of p, which are smooth. That gives correct mip
  selection and anisotropy at tilted views.

### 6.4 `setOrigin(material, positions)` (CPU)

1. The center is the center of the positions' bounding sphere, scaled down onto the WGS84
   surface (`scaleToGeodeticSurface`).
2. Set `localToWorld` to the east-north-up frame at that center
   (`Transforms.eastNorthUpToFixedFrame`).
3. Set `worldToLocal` to its inverse (`Matrix4.inverseTransformation`).

### 6.5 `updateCamera(material, scene)` (CPU, double precision)

1. **Max height and zoom settle:** set the `sizeScale` uniform from the camera height, the
   material's `maxHeight` and its `heightTransition` (Step 4). The level is log2(`tileSize` ×
   `referenceMetersPerPixel` × size scale) + 0.5. Call `updateZoomSettle` with one layer,
   `tile`, at that level with the window 0.8 to 1, and store its shift in `levelShift`.
2. **Eye-to-local matrix:** multiply the camera's view matrix by `localToWorld` (the
   model-view matrix), invert it (`Matrix4.inverseTransformation`), and pack the result into the
   `eyeToLocal` array.
3. **Sphere under the camera.** Refit it **every frame**; don't fit it at the polygon's center.
   - The nadir is the camera's world position scaled onto the WGS84 surface. Stop here if there
     is none (the camera is at the earth's center).
   - Up is the surface normal at the nadir, and the radius is `gaussianRadius` there (6.6).
   - The sphere's center in world coordinates is the nadir minus up × radius; transform it into
     the local frame with `worldToLocal`.
4. **Camera values:**
   - The camera's position in the local frame is the translation part of the eye-to-local
     matrix.
   - Take the offset from the sphere's center to the camera, and its length (the distance).
   - Set the `radius` uniform to the radius, `cameraHeight` to the distance minus the radius,
     and `cameraUp` to the offset divided by the distance, writing into the existing object.
5. **Float split:** `cameraHigh` is the camera's local x and y each rounded to a 32-bit float
   (`Math.fround`), and `cameraLow` is the remainder (the double value minus the rounded one).

**Pitfall:** a sphere fitted at the polygon's center sits about 50 m below the real surface
1,000 km away. The pattern then lags the camera and looks stuck to the screen up close. The
symptom is `cameraHeight` reading about 50 m while the camera is actually 1 m above the ground.

### 6.6 `gaussianRadius(ellipsoid, surfacePoint)`

The Gaussian radius of curvature at a surface point, √(M × N):

- a is the ellipsoid's maximum radius, and the squared eccentricity e² is 1 − (minimum radius /
  a)²;
- with φ the point's geodetic latitude, w² = 1 − e² × sin²φ;
- the prime vertical radius is N = a / √w²;
- the meridian radius is M = a × (1 − e²) / (w² × √w²);
- return √(M × N).

---

## Step 7 — `src/solutions/worldSpace/renderer.js` and `src/solutions/index.js`

**Why it's needed:** the materials don't create primitives or hook into the frame loop. The
renderer turns each shape from the draw tool (Step 8) into ground-clamped primitives with its
own material, and does every per-frame and lifetime job from "Caller responsibilities" in
section 0.

### 7.1 API

The module's default export is an **async** function `createRenderer(viewer)`. It resolves to an
object with these methods:

| method | does |
|---|---|
| `update(shape)` | creates or rebuilds the shape's primitives (`shape.type` is `"polyline"` or `"polygon"`) |
| `remove(shape)` | removes its primitives, destroys its material(s) and forgets it; it only reads `shape.id`, and does nothing for an unknown id |
| `setLineWidth(width)` | sets the polyline width in pixels and rebuilds every polyline |
| `setDetail(settings)` | merges the given fields into the detail settings (7.3) and rebuilds every shape |
| `setMaxHeight({ factor, easeFrom })` | sets the per-shape max height in fit heights (`Infinity` = off) and where easing starts, in the same units; omitted fields keep their value; no rebuild |
| `setStampSpacing(spacing)` | writes the `spacing` uniform of every polyline material; no rebuild |
| `setImages({ line, stamp })` | takes image keys from `LINE_IMAGES` / `STAMP_IMAGES`; `null` removes that layer and `undefined` keeps it; applies them to every polyline with `PolylinePatternMaterial.setImages` |
| `destroy()` | removes every shape, both frame listeners and the outline material |

A shape is an object with an `id`, a `type` and `positions` (Cartesian3 points on the
ellipsoid).

### 7.2 Setup

1. Before returning, load everything **in parallel** and wait for all of it: every line image,
   every stamp image, the hatch image, and `GroundPrimitive.initializeTerrainHeights()`. Load an
   image by creating an `Image`, setting its `src`, and awaiting its `decode()`. Keep the decoded
   line and stamp images in objects keyed like `LINE_IMAGES` / `STAMP_IMAGES`. Every material
   shares these decoded images, so a new shape never waits for its own image load.
2. Create one shared outline material: Cesium's built-in `Color` material type, white at 80%
   opacity.
3. Keep this state: a `Map` from shape id to render state, the current line width (starting at
   `LINE_WIDTH`), stamp spacing (`STAMP_SPACING`), max height factor (`Infinity`) and ease-from
   value (0), and the current line and stamp image keys (`DEFAULT_LINE_IMAGE`,
   `DEFAULT_STAMP_IMAGE`). A key of `null` stands for no image.

### 7.3 Geometry detail

By default Cesium subdivides lines every 10 km and polygons on a 1° grid, which made rebuilding
continent-sized shapes on every drag step lag. Scale the detail with each shape's size instead,
from these settings:

| setting | default | meaning |
|---|---|---|
| `lineSegments` | 256 | target number of pieces per line |
| `minLineGranularity` | 9999 m | Cesium's default; finer isn't needed |
| `maxLineGranularity` | 200,000 m | coarser pieces sag too far below the curved ground |
| `polygonCells` | 32 | target number of grid cells across a polygon |
| `minPolygonGranularity` | 1° in radians | Cesium's default |
| `maxPolygonGranularity` | 5° in radians | |

- **Line granularity:** add up the straight-line distances between consecutive positions (plus
  last to first for a loop with more than two positions), divide by `lineSegments`, and clamp to
  the line minimum and maximum.
- **Polygon granularity:** take the diameter of the positions' bounding sphere, divide it by the
  ellipsoid's maximum radius to get radians across, divide by `polygonCells`, and clamp to the
  polygon minimum and maximum.

### 7.4 Building shapes

A helper `groundLine(positions, width, material, loop)` (loop defaults to false) adds a
`GroundPolylinePrimitive` to the scene and returns it. The primitive has one geometry instance:
a `GroundPolylineGeometry` with the positions, width, loop flag and the line granularity from
7.3. Its appearance is a `PolylineMaterialAppearance` with the given material, and it's created
with `asynchronous: false`.

A helper `replace(state, key, primitive)` removes the primitive stored under `key` from the
scene's primitive collection, if there is one (the collection destroys it), then stores the new
one under that key.

**Polyline:**
1. The first time a shape id is seen, create its state with a new
   `PolylinePatternMaterial`, using the current line and stamp images, `LINE_COLOR`,
   `STAMP_COLOR` and the current stamp spacing.
2. Store a **copy** of the shape's positions (the draw tool mutates its own array) and their
   bounding-box diagonal (`boundingBoxDiagonal`, Step 4).
3. Build it: call `setPositions` on the material with the positions and current line width,
   then apply the max height (below), then call the material's `updateCamera`, then replace the
   state's `primitive` with a new ground line using that material and width.

**Polygon:**
1. The first time a shape id is seen, create its state with a new `PolygonPatternMaterial`,
   using the hatch image, `HATCH_COLOR` and `HATCH_TILE_PIXELS`.
2. Store the shape itself (so `setDetail` can rebuild it) and its bounding-box diagonal.
3. Call `setOrigin` with the positions, apply the max height, and call `updateCamera`.
4. Replace the state's `primitive` with a new `GroundPrimitive`:
   - its geometry instance holds a `PolygonGeometry` built from a `PolygonHierarchy` of the
     positions, using the vertex format of `MaterialAppearance.MaterialSupport.TEXTURED` and the
     polygon granularity from 7.3;
   - its appearance is a `MaterialAppearance` with the shape's material, `TEXTURED` material
     support, translucent and flat;
   - it's created with `asynchronous: false`.
5. Replace the state's `outline` with a 2-pixel ground line of the same positions, using the
   shared outline material, as a closed loop.

**Applying the max height:** compute `fitMaxHeight` (Step 4) from the state's diagonal, the
camera, and the current factor and ease-from value, and copy the resulting `maxHeight` and
`heightTransition` onto the state's material(s).

**Pitfalls:**
- Call `updateCamera` **before** creating the new primitive, so its uniforms are valid on the
  first frame it draws. Otherwise a rebuilt shape flashes for one frame while dragging.
- Keep the shape's material across rebuilds; only the primitive is replaced. A new material per
  drag step would re-upload textures and reset the zoom settle state.
- `asynchronous: false` keeps editing flicker-free, because the old primitive is replaced in the
  same frame. It requires `initializeTerrainHeights` to have finished.
- `remove` must destroy the materials itself (skipping any already destroyed); primitives don't
  destroy their appearance's material.

### 7.5 Frame hooks

Register two scene listeners and keep the functions that unregister them (`destroy` calls
both):

- **After each frame (`postRender`):** if any shape's material has a non-empty `loadingImages`
  set, request another frame. This keeps frames coming until every image is on the GPU, without
  the camera having to move.
- **Before each frame (`preRender`):** for every shape, apply the max height (it depends on the
  camera's field of view), then call `updateCamera` on its polygon material and/or polyline
  material.

### 7.6 `src/solutions/index.js`

The app was built to compare candidate implementations, and there is now one. Keep a list
anyway, so `main.js` doesn't depend on the implementation. The module's default export is an
array with one entry:

- `id`: `"worldSpace"`;
- `label`: "World space (ground clamped)";
- `description`: "Shapes drape on the globe. X's are anchored to the line at constant pixel
  size; hatch is anchored to the ground and adapts its density to the zoom level.";
- `createRenderer`: the function from 7.1.

Document that each entry's `createRenderer(viewer)` returns, or resolves to, an object with at
least `update`, `remove` and `destroy`.

---

## Step 8 — `src/tools/DrawTool.js`

**Why it's needed:** interactive drawing and editing. It knows nothing about rendering; it
reports changes through callbacks.

### 8.1 API

Export a constant `MIN_POINTS`: 2 for `polyline`, 3 for `polygon`.

The default export is a class `DrawTool`, constructed with the viewer and an options object with
three callbacks, each defaulting to a function that does nothing:
- `onChange(shape)`: the shape's positions changed;
- `onRemove(shape)`: the shape was deleted;
- `onHint(text)`: status text for the toolbar.

| member | does |
|---|---|
| `shapes` | array of every shape, including the one being drawn |
| `active` | the shape being drawn, or `undefined` |
| `start(type)` | cancels any shape in progress and starts a new one; hint "Drawing polyline: click to add vertices, double-click or right-click to finish." (with the type) |
| `finish()` | ends the active shape: removes it if it has fewer than `MIN_POINTS` clicked vertices, otherwise marks it complete and calls `onChange`; hint "Drag the white vertex handles to edit. Pick a tool to draw another shape." |
| `cancel()` | removes the active shape |
| `addShape(type, positions)` | adds a finished, editable shape from code and calls `onChange`; returns `undefined` if there are too few positions |
| `setHandleScale(scale, shapes)` | resizes the given shapes' vertex handles (default: all shapes; 1 = full size); requests a frame only if something changed |
| `clear()` | removes every shape; hint "Pick a tool to start drawing." |
| `destroy()` | clears, destroys the event handler and removes the handle collection |

Each shape is an object with:
- `id`: from a module-level counter that increases with every shape;
- `type`: `"polyline"` or `"polygon"`;
- `committed`: the clicked vertices, as Cartesian3;
- `floating`: the vertex following the mouse while drawing, or `undefined`;
- `handles`: the point primitives, one per committed vertex;
- `complete`: false while drawing;
- `positions`: a **getter** returning the committed vertices plus the floating one when there
  is one. For shapes made by `addShape`, it returns just the committed vertices, and `complete`
  starts true.

### 8.2 Behaviour

- Constants: duplicate-click distance 4 px, handle size 12 px, handle outline 2 px, smallest
  handle size 4 px.
- In the constructor, add a `PointPrimitiveCollection` to the scene for the handles and create a
  `ScreenSpaceEventHandler` on the canvas. Remove the viewer's own left-double-click action from
  the Cesium widget's event handler: double-click finishes a shape here instead of tracking an
  entity.
- Pick positions on the ellipsoid with the camera's `pickEllipsoid`, and ignore events where it
  finds nothing (the mouse is over the sky).
- **Left click** while drawing: ignore it if it's within 4 px of the previous click (this
  swallows the second click of a double-click). Otherwise add the position to `committed`, add a
  handle for it, clear `floating`, and call `onChange` once the shape has `MIN_POINTS`
  positions.
- **Left double-click** and **right click**: `finish()`.
- **Mouse move:** while dragging a handle, move that vertex and its handle, request a frame and
  call `onChange`. While drawing with at least one committed vertex, set `floating` to the mouse
  position and notify as for a click.
- **Left button down** (not while drawing): pick the scene at that position. If the picked
  object's id is one of this tool's handles, start dragging it, turn off camera input
  (`screenSpaceCameraController.enableInputs`) and color the handle yellow.
- **Left button up:** end the drag, turn the handle white again and turn camera input back on.
- A **handle** is a point at the vertex, white with a black outline, sized as below, and with
  `disableDepthTestDistance` set to infinity so the globe never hides it. Its `id` is an object
  that marks it as a draw-tool handle and holds the shape, the vertex index and the point
  itself (set after adding), so picking can find the vertex.
- **Handle size:** the handle size times the shape's handle scale (1 if unset), but never below
  the smallest size; the outline scales in proportion (2 px at full size).
- **Removing a shape** removes its handles, drops it from `shapes`, requests a frame and calls
  `onRemove`.
- Request a frame whenever the handles change: the scene renders on demand.

---

## Step 9 — `src/main.js`

### 9.1 Viewer

Create a Cesium `Viewer` in `#cesiumContainer` with:
- **Imagery:** a base layer from a `TileMapServiceImageryProvider` loading the Natural Earth II
  imagery bundled with Cesium (the module URL `Assets/Textures/NaturalEarthII`). This needs no
  Cesium Ion token.
- **No widgets:** turn off the base layer picker, geocoder, home button, scene mode picker,
  navigation help, animation, timeline, fullscreen button, info box and selection indicator.
- **Render on demand:** `requestRenderMode` on and `maximumRenderTimeChange` infinite. Every
  change the app makes must then request a frame.
- ⚠️ **No MSAA** (`msaaSamples` 1): with MSAA, ground-clamped lines lose scattered pixels to
  Cesium's depth-based tests at large distances and look torn, even with a plain color material.
- **3D only** (`scene3DOnly`): primitives then skip building 2D / Columbus-view geometry, which
  roughly halves the cost of rebuilding shapes while editing.

Then turn off the globe's `depthTestAgainstTerrain`, and start the camera 15 km above Denver
(longitude −104.99, latitude 39.74).

### 9.2 Renderer selection

Write an async `useSolution(id)` that:
1. picks the solution with that id from Step 7's list (or the first one), remembers its id, and
   shows its description in `#solutionDescription`;
2. destroys the current renderer and clears it, then awaits the new solution's
   `createRenderer(viewer)`;
3. guards against overlapping calls with a counter that each call increments: if a newer call
   started while this one was waiting, destroy the renderer just created and stop;
4. applies the current line width, stamp spacing, max height and images to the new renderer
   (calling each setter only if the renderer has it);
5. calls `update` for every draw-tool shape that has at least `MIN_POINTS` positions, and
   requests a frame.

The renderer is unset while it's being created, so everything else must cope with it being
missing. Call `useSolution()` once at startup, after the controls below are set up.

### 9.3 Toolbar

- **Draw tool:** its `onChange` updates the shape in the renderer and requests a frame; its
  `onRemove` removes it from the renderer and requests a frame; its `onHint` shows the text in
  `#hint` and gives the `active` class only to the button for the tool being drawn. The three
  buttons start a polyline, start a polygon, and clear everything.
- **Line width:** starts at `LINE_WIDTH`. The value span shows it as "24 px". On input, pass the
  new width to the renderer's `setLineWidth`.
- **Stamp spacing:** logarithmic. A slider value v means a spacing of 2^v, and setting a
  spacing from code writes log2(spacing) back to the slider. Starts at `STAMP_SPACING`. The value
  span shows it with two decimals and a × sign ("1.00×"). On input, pass it to the renderer's
  `setStampSpacing`.
- **Max height:** two handles, where a value v means 2^v fit heights. The upper handle is the
  max height, and at its far right end (the slider's maximum) it means off (`Infinity`). The
  lower handle is where easing starts. It starts off.
  - When one handle is dragged past the other, push the other one along with it.
  - The value span shows "Off", or the max height as "2.00× fit", followed by ", easing from
    0.50×" when the ease start is below the max height.
  - Where the two handles coincide (and the slider isn't off), put the lower one on top
    (higher z-index) so it can be dragged out to add a transition; otherwise the upper one is on
    top.
  - Pass the factor and ease start to the renderer's `setMaxHeight`.
  - Also write a `setMaxHeight(factor, easeFrom)` function that sets both handles from values,
    with `easeFrom` defaulting to `factor` (no easing).
- **Vertex handles follow the max height:** before each frame, for every draw-tool shape,
  compute `fitMaxHeight` from the shape's bounding-box diagonal and the current settings, then
  `sizeScale` from the camera height, and pass that to `setHandleScale` for that shape. Handles
  then shrink with each shape's patterns.
- **Image selects:** an empty value means `null`. On change, pass the line and stamp keys to the
  renderer's `setImages`.
- **Camera height readout:** after each frame, show "Camera height: " followed by the height
  with two decimals in meters below 10 m, one decimal in meters below 1 km, and otherwise in
  kilometres with two decimals (formatted for the locale). Only touch the page when the text
  changes.

### 9.4 Console helpers

Put an `app` object on `window` for debugging and for sharing an exact view. It holds the
viewer, the draw tool, `useSolution`, `setMaxHeight`, `exportState`, `importState`, and a
getter for the current renderer.

- **`exportState()`** builds a JSON string, copies it to the clipboard (logging whether that
  worked) and returns it. It contains:
  - the solution id, line width and stamp spacing;
  - the max height factor (`null` when off, since JSON has no infinity) and its ease start;
  - the line and stamp image keys;
  - the canvas width and height;
  - the camera: longitude and latitude in degrees, height in meters, and heading, pitch and roll
    in radians;
  - every **complete** shape: its type and its positions as longitude/latitude pairs in
    degrees.
- **`importState(json)`** accepts that string or the parsed object. It switches solution if
  the id differs, applies every setting that's present (updating the controls too), clears the
  draw tool, re-adds the shapes with `addShape`, sets the camera view and requests a frame. If
  the saved canvas size differs from the current one, it logs a note that the framing will
  differ slightly.

---

## Step 10 — Verify

Run `npm install` once, then `npm run dev` (http://localhost:5173), and work through these
checks. To set up an exact scene repeatably, build it once and save `app.exportState()`, then
restore it with `app.importState(json)` (9.4). Use a real GPU. Chrome's software renderer
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
| Solid block flashes when a shape is created | Missing placeholder check (texture 1 pixel wide or less) |
| A new or swapped image only appears after moving the camera | `loadingImages` not tracked, or the caller doesn't request frames while it's non-empty |
| Torn X at a corner | Stamps reaching across the vertex not drawn, or `vertexFrames` not uploaded (its size isn't exactly vertex count × 4, so the check fails) |
| Stray bracket shape in a corner's wedge | This segment's stamps (`stampsAt` at d) drawn where `pastOwnEnd` is true |
| Blocky stamp edges at a corner wedge | Wedge detected with screen-space derivatives instead of `pastOwnEnd` |
| X overhanging the line start with spacing < 1 | Missing `startGap` fade in `stampsAt` |
| Pattern stays half faded when the camera stops | Zoom settle missing, or its window doesn't match the shader's fade |
| Line pattern stretches when a vertex moves | Period derived from segment length instead of `2^k` meters |
| Shader fails to compile mentioning `step` | A local variable named `step` (a GLSL built-in) |
