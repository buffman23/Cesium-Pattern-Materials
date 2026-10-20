# Implementation plan: ground-anchored pattern materials

This is a step-by-step plan for building three files from scratch:

- `src/shared/mipmapTexture.js`
- `src/solutions/worldSpace/PolylinePatternMaterial.js`
- `src/solutions/worldSpace/PolygonPatternMaterial.js`

Follow the steps in order. Each step lists **what to build**, the **exact formulas or code**
where they matter, and **pitfalls**. Each pitfall is a mistake that was made and fixed in the
original implementation, so don't skip them. Background on why the design works is in
`README.md`.

---

## 0. Ground rules and context

### Environment

- CesiumJS **1.122** (`import { ... } from "cesium"`), WebGL2, so GLSL ES 3.00
  (`texture`, `textureLod`, `textureGrad` and `textureSize` are available).
- Globe: WGS84 ellipsoid, **no terrain**. Always use `Ellipsoid.WGS84`.
- Use plain ES modules, 2-space indentation and double quotes, matching the existing files.

### Public API and usage requirements

The materials import only `"cesium"` and `mipmapTexture.js`; nothing else in the app. They
don't control how they're used, though. The shaders depend on specific Cesium primitives and on
per-frame calls from whatever code uses them. Build the API below exactly, and document these
requirements in each file's comments:

- **PolylinePatternMaterial:**
  - `create({ image, color, spacing, vertexMode })` returns a `Material`.
    `PolylinePatternMaterial.VertexMode` is the enum for `vertexMode`. It can be changed later
    through `material.uniforms.vertexMode`.
    - `image` is **one stamp**. Its size on screen is never configured: it's always drawn as
      tall as the line is wide and `lineWidth × imageWidth / imageHeight` long.
    - `spacing` is optional, defaults to 1, and can be changed later through
      `material.uniforms.spacing`. It only adds gap between stamps.
  - `setPositions(material, positions, width)` must be called whenever the line's positions or
    width change. `width` is the same pixel width given to `GroundPolylineGeometry`.
  - `updateCamera(material, camera)` must be called **every frame**, for example from
    `scene.preRender`.
  - It must be rendered with `GroundPolylinePrimitive` + `GroundPolylineGeometry` +
    `PolylineMaterialAppearance`. The shader relies on three things from that primitive:
    - `st.s` being the normalized arc length along the whole line;
    - the `v_width` varying, the line width in CSS pixels;
    - Cesium's globe depth texture.
- **PolygonPatternMaterial:**
  - `create({ image, color, tileSize })` returns a `Material`.
  - `setOrigin(material, positions)` must be called whenever the polygon's positions change.
  - `updateCamera(material, camera)` must be called **every frame**.
  - It must be rendered with a primitive whose material input provides `positionToEyeEC`, such
    as `GroundPrimitive` + `PolygonGeometry` + a flat, translucent `MaterialAppearance`.
- `image` may be a URL or an `HTMLImageElement`. The test images are a 256×128 X stamp and a
  256×256 seamless 45° hatch.

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
  | image | `sampler2D` |
- **Matrices:** ⚠️ Material does **not** accept a `Matrix4` instance; it throws "uniform has
  invalid type". Pass a plain 16-number array, `Matrix4.toArray(Matrix4.IDENTITY)`, and
  update it with `Matrix4.pack(matrix, uniforms.eyeToLocal)`.
- **Return value:** each `create()` returns the `Material` after passing it through
  `mipmapTexture(...)`.

### Shader code shared by both materials

Put these blocks in **both** shaders. Each pitfall in the comments was hit before.

```glsl
// (1) At the very top of czm_getMaterial: until the image loads, Cesium binds a 1x1 white
//     placeholder texture, which would render as a solid block. Draw nothing instead.
if (textureSize(image, 0).x <= 1) {
    discard;
}
```

```glsl
// (2) After sampling: browsers decode transparent SVG/PNG pixels as black; filtering blends that
//     black into stroke edges (dark fringe). Un-premultiply, then tint.
tex.rgb = min(tex.rgb / max(tex.a, 0.0001), 1.0);
vec4 fragColor = tex * color;
if (fragColor.a < 0.005) {
    discard;
}
fragColor = czm_gammaCorrect(fragColor);
```

---

## Step 1 — `src/shared/mipmapTexture.js`

**Why it's needed:** Cesium's Material uploads images **without mipmaps**. A 256 px tile drawn
at about 12 px then produces moiré bands, and the hatch can look solid.

**Build:** a default-exported function
`mipmapTexture(material, uniformName, { wrapS = TextureWrap.REPEAT, wrapT = TextureWrap.REPEAT } = {})`
that returns `material`.

1. Save the original update function: `const originalUpdate = material.update.bind(material)`.
   Keep a variable `mipmapped`, initially undefined.
2. Replace `material.update = function (context) { ... }` with a version that:
   - calls `originalUpdate(context)` first;
   - reads `const texture = material._textures[uniformName]`. This is a private Cesium field;
     say so in a comment;
   - returns early if `!texture`, if `texture === context.defaultTexture` (the image isn't
     loaded yet), or if `texture === mipmapped` (already done);
   - otherwise calls `texture.generateMipmap()`;
   - then sets
     `texture.sampler = new Sampler({ wrapS, wrapT, minificationFilter: TextureMinificationFilter.LINEAR_MIPMAP_LINEAR, maximumAnisotropy: 8 })`;
   - then sets `mipmapped = texture`.
3. Imports: `Sampler`, `TextureMinificationFilter` and `TextureWrap` from `"cesium"`.

**Pitfalls:**
- Don't replace the texture yourself, only its sampler.
- Don't call `generateMipmap` every frame.

---

## Step 2 — `src/solutions/worldSpace/PolylinePatternMaterial.js`

### 2.1 Behaviour to achieve

**The stamp image.** The test image is 256×128: a horizontal line through the middle and one
tall "X". The image is one stamp. Along the draped line it repeats as follows:

- **Size.** Each stamp spans the full line width and is drawn undistorted, so it's
  `lineWidth × imageWidth / imageHeight` pixels long. Nothing configures this: the shader reads
  the width from `v_width` and the aspect ratio from `textureSize`. Seen top-down, the stamp is
  a constant pixel size at every zoom.
- **Anchoring.** Stamps are pinned to positions along the line, so they don't slide when the
  camera pans.
- **Spacing.** The repeat length is `stamp length × spacing`, where `spacing` defaults to 1 and
  can range from 0.25 upward. Stamps are spaced `2^k` meters apart, with `k` chosen per fragment
  so the spacing is 1–2× the repeat length on screen. Above 1, the extra room is filled with the
  edge column. Below 1, stamps overlap and are layered over each other. The stamp is never
  stretched.
- **Fade.** Every second stamp fades out as the spacing approaches 1×, so nothing pops when
  `k` changes.
- **Gaps.** Between stamps, the image's **edge column** (the plain line) is drawn, so the line
  stays continuous.
- **Vertices.** A stamp drawn across a vertex would be torn in two, because the line changes
  direction there. In the mitered wedge outside a corner, Cesium clamps `st.s` to the vertex,
  so every wedge pixel would read the same image column and smear it into a stray bracket.
  **The wedge therefore always shows only the edge column.** What happens near vertices is set
  by the `vertexMode` enum, `PolylinePatternMaterial.VertexMode`:

  | mode | value | behaviour |
  |---|---|---|
  | `SKIP` | 0 | Global stamp grid; any stamp overlapping a vertex (including the line ends) is left out. |
  | `CLIP` | 1 | Global grid; stamps run up to the vertex and are cut there. A pixel only draws stamps centred in its own segment. |
  | `SNAP` | 2 | Stamps at the interior points `i / n` of each segment, with `n` a power of two so zoom levels nest. The gap at a vertex equals the interior spacing. |
  | `FIT` | 3 | Per segment, the first and last stamp touch the vertices, with power-of-two divisions in between. Stamp ground length changes with zoom, so stamps shift slightly while zooming. |
  | `CORNER` | 4 | `SKIP`, plus the stamp's symbol (without its line) centred on each interior vertex, aligned with the corner's mean direction. |

**Inputs from `GroundPolylinePrimitive`:**
- `materialInput.st.s` is the arc length along the **whole** line, normalized to 0..1.
- `materialInput.st.t` is the position across the width, 0..1.
- `v_width` is the line width in CSS pixels. Cesium only provides it when the material source
  contains the exact declaration `in float v_width;`.

### 2.2 Uniforms

| name | JS initial value | meaning |
|---|---|---|
| `image` | from options | stamp image |
| `color` | `Color.WHITE` default | tint |
| `spacing` | `1` default | repeat length as a multiple of the stamp length; clamped to ≥ `MIN_SPACING` = 0.25 (a GLSL `const` and a matching JS `const`) |
| `lineLength` | `1` | geodesic length of the line in meters (set by `setPositions`) |
| `preciseMetersPerPixel` | `0` | switch-over threshold for the close-zoom path |
| `referenceA`, `referenceB` | `new Cartesian4()` | xyz: point on the line in eye coordinates; w: distance along the line mod `modulus` |
| `tangentA`, `tangentB` | `new Cartesian4()` | xyz: unit line direction in eye coordinates; w: 1 if valid, else 0 |
| `rangeA`, `rangeB` | `new Cartesian2()` | distance along the line from that reference point to its segment's start (x, ≤ 0) and end (y, ≥ 0) |
| `vertexMode` | `VertexMode.SKIP` default | one of the `VertexMode` values (a float in GLSL, compared to `MODE_*` constants) |
| `vertexDistances` | `Material.DefaultImageId` | float data texture: distance along the line of each vertex, ascending (see 2.4) |
| `vertexCount` | `0` | number of texels in `vertexDistances` |
| `cornerFrames` | `Material.DefaultImageId` | CORNER mode. Float data texture, `vertexCount × 3`. Texel `(v, 0)` is vertex `v`'s eye position, with `w = 1` if it's an interior vertex. Rows 1 and 2 are the symbol's x and y axes, in eye coordinates. Re-uploaded every frame. |
| `nearCorner`, `nearCornerX`, `nearCornerY` | `new Cartesian4()` | CORNER mode, close-zoom path: the interior vertex nearest the camera (eye position, `w = 1` if any) and its axes |

Also export `VertexMode = Object.freeze({ SKIP: 0, CLIP: 1, SNAP: 2, FIT: 3, CORNER: 4 })` as
`PolylinePatternMaterial.VertexMode`, and add `vertexMode` to the `create()` options.

`TYPE = "PolylinePatternWorld"`. In `create()`:
- set `material.segments = []`, `material.corners = []`, `material.pendingVertexDistances` and
  `material.pendingCornerFrames` to `undefined`;
- set `material.lineWidth = 1` and `material.imageAspect = imageAspect(image)`.
  `imageAspect` returns `width / height` from `naturalWidth/naturalHeight` (or `width/height`)
  for an image or canvas, and 1 for a URL that hasn't loaded yet. These are CPU-side copies,
  used only by the close-zoom math in 2.5;
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
    if (material.pendingCornerFrames) {
      const { width, data } = material.pendingCornerFrames;
      const texture = uniforms.cornerFrames;
      if (texture instanceof Texture && texture.width === width && texture.height === 3) {
        texture.copyFrom({ source: { width, height: 3, arrayBufferView: data } });  // reuse
      } else {
        uniforms.cornerFrames = createDataTexture(context, width, 3, (target) => target.set(data));
      }
      material.pendingCornerFrames = undefined;
    }
    originalUpdate(context);
    // Once a URL image has loaded, take the aspect ratio from the (private) texture map.
    const texture = material._textures.image;
    if (texture && texture !== context.defaultTexture && texture.height > 0) {
      material.imageAspect = texture.width / texture.height;
    }
  };
  ```
  Assigning a `Texture` instance to the uniform works because Material uses it directly and
  destroys the previous one.
- `createDataTexture(context, width, height, fill)` allocates a `Float32Array(width * height * 4)`,
  calls `fill(data)`, and returns a `width × height` texture. It uses
  `pixelFormat: PixelFormat.RGBA`, `pixelDatatype: PixelDatatype.FLOAT` and `flipY: false`, with
  a NEAREST / CLAMP_TO_EDGE `Sampler`. Rows are stored one after another, so texel `(x, y)` is
  at `data[(y * width + x) * 4]`.
- return `mipmapTexture(material, "image", { wrapS: TextureWrap.CLAMP_TO_EDGE, wrapT: TextureWrap.CLAMP_TO_EDGE })`.

> ⚠️ `wrapS` **must** be `CLAMP_TO_EDGE`. The gaps between stamps sample `u` outside 0..1 and
> rely on the clamped edge column to draw the plain line.

### 2.3 Fragment shader, in this order

Declare `in float v_width;` at the top of the source, before the uniforms. Then, before
`czm_getMaterial`, add the vertex lookup helpers:

```glsl
const float MIN_SPACING = 0.25;
const float MODE_SKIP = 0.0;
const float MODE_CLIP = 1.0;
const float MODE_SNAP = 2.0;
const float MODE_FIT = 3.0;
const float MODE_CORNER = 4.0;

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

float nearestVertexGap(float c) {
    if (vertexCount < 2.0) { return 1e30; }
    int i = segmentIndex(c);
    return min(abs(c - vertexDistanceAt(i)), abs(c - vertexDistanceAt(i + 1)));
}

// How much of stamp number "i", centred at "center", to draw (0..1).
float stampKeep(float i, float center, float fadeOut, float halfStamp, float segmentStart,
                float segmentEnd, bool precise, vec2 preciseVertices) {
    float keep = mod(i, 2.0) < 0.5 ? 1.0 : 1.0 - fadeOut;      // zoom-level fade
    if (vertexMode == MODE_CLIP) {                              // cut at the vertex
        return center >= segmentStart && center <= segmentEnd ? keep : 0.0;
    }
    if (vertexMode == MODE_FIT) { return keep; }                // touches, never crosses
    float vertexGap = precise                                   // SKIP / SNAP / CORNER
        ? min(abs(center - preciseVertices.x), abs(center - preciseVertices.y))
        : nearestVertexGap(center);
    return keep * smoothstep(halfStamp, 1.2 * halfStamp, vertexGap);
}
```

> ⚠️ The GLSL lives in a JavaScript template string, so **never put a backtick in a shader
> comment**. It ends the string and breaks the JS.

Then, inside `czm_getMaterial`:

```glsl
// (shared block 1: placeholder discard)

// The corner wedge has a constant (clamped) st.s. Take derivatives HERE, in uniform control flow.
float sChange = abs(dFdx(materialInput.st.s)) + abs(dFdy(materialInput.st.s));

float d = materialInput.st.s * lineLength;      // meters along the line

// Pixel size at this fragment, computed the way GroundPolylinePrimitive sizes its width.
float depth = czm_unpackDepth(texture(czm_globeDepthTexture, gl_FragCoord.xy / czm_viewport.zw));
vec4 eyeCoordinate = czm_windowToEyeCoordinates(gl_FragCoord.xy, depth);
eyeCoordinate /= eyeCoordinate.w;
float metersPerPixel = max(czm_metersPerPixel(eyeCoordinate), 1e-6);   // per CSS pixel
vec2 imageSize = vec2(textureSize(image, 0));
float stampPixels = v_width * imageSize.x / imageSize.y;   // undistorted stamp, CSS pixels
float repeatPixels = stampPixels * max(spacing, MIN_SPACING);
float stampMeters = stampPixels * metersPerPixel;
float halfStamp = 0.5 * stampMeters;

// Close-zoom precision path (see 2.5).
bool precise = false;
vec2 preciseVertices = vec2(0.0);   // the chosen segment's two ends, same units as d
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
}

// This fragment's segment, and whether it's in a corner's mitered wedge.
float segmentStart = 0.0;
float segmentEnd = lineLength;
int segment = 0;
if (precise) {
    segmentStart = preciseVertices.x;
    segmentEnd = preciseVertices.y;
} else if (vertexCount >= 2.0) {
    segment = segmentIndex(d);
    segmentStart = vertexDistanceAt(segment);
    segmentEnd = vertexDistanceAt(segment + 1);
}
bool wedge = precise ? (d < segmentStart || d > segmentEnd) : sChange == 0.0;

float level = log2(repeatPixels * metersPerPixel);  // 2^level m == one repeat on screen
float k = ceil(level);                               // ceil, NOT floor
float gridSpacing = exp2(k);                         // 1x..2x a repeat on screen
float fadeOut = smoothstep(0.5, 1.0, 1.0 - (k - level));

// Stamp centres are origin + i * stampStep for whole i in [first, last].
float origin = 0.0;
float stampStep = gridSpacing;                       // NOT "step": that's a GLSL built-in
float first = -1e30;
float last = 1e30;
if (vertexMode == MODE_SNAP || vertexMode == MODE_FIT) {
    float segmentLength = segmentEnd - segmentStart;
    float available = vertexMode == MODE_FIT ? segmentLength - stampMeters : segmentLength;
    // Power-of-two divisions, so the next zoom level's stamps are a subset of these.
    float divisions = available >= gridSpacing ? exp2(floor(log2(available / gridSpacing))) : 0.0;
    if (vertexMode == MODE_SNAP) {
        origin = segmentStart; stampStep = segmentLength / max(divisions, 1.0);
        first = 1.0; last = divisions - 1.0;                       // interior points only
    } else if (divisions > 0.0) {
        origin = segmentStart + halfStamp; stampStep = available / divisions;
        first = 0.0; last = divisions;                             // ends touch the vertices
    } else {
        origin = 0.5 * (segmentStart + segmentEnd);                // one stamp at most: centre it
        first = 0.0; last = available >= 0.0 ? 0.0 : -1.0;
    }
}

float t = materialInput.st.t;
float lod = max(log2(imageSize.x / (stampPixels * czm_pixelRatio)), 0.0);   // device pixels
vec4 edge = textureLod(image, vec2(0.0, t), lod);
vec4 tex = edge;

// Nearest stamp replaces the edge column (its u may be outside 0..1 = the gap); with
// spacing < 1, neighbours that also cover this fragment are layered on top ("over" on
// effectively premultiplied samples). Two per side cover every spacing >= MIN_SPACING.
if (!wedge && first <= last) {
    float nearest = clamp(floor((d - origin) / stampStep + 0.5), first, last);
    for (int j = -2; j <= 2; j++) {
        float i = nearest + float(j);
        if (i < first || i > last) { continue; }
        float center = origin + i * stampStep;
        float u = 0.5 + (d - center) / stampMeters;    // divide by the STAMP, not the repeat
        if (j != 0 && (u <= 0.0 || u >= 1.0)) { continue; }
        float keep = stampKeep(i, center, fadeOut, halfStamp, segmentStart, segmentEnd,
                               precise, preciseVertices);
        vec4 stamp = textureLod(image, vec2(u, t), lod);
        if (j == 0) { tex = mix(edge, stamp, keep); }
        else { stamp *= keep; tex = stamp + tex * (1.0 - stamp.a); }
    }
}

// CORNER: the symbol centred on the nearest interior vertex, in that corner's own frame. It
// uses the fragment's eye position, so it also covers the wedge.
if (vertexMode == MODE_CORNER) {
    vec4 corner = nearCorner;
    vec3 axisX = nearCornerX.xyz;
    vec3 axisY = nearCornerY.xyz;
    if (!precise) {
        corner = vec4(0.0);
        if (vertexCount >= 2.0 && textureSize(cornerFrames, 0) == ivec2(int(vertexCount), 3)) {
            int v = abs(d - vertexDistanceAt(segment)) <= abs(d - vertexDistanceAt(segment + 1))
                ? segment : segment + 1;
            corner = texelFetch(cornerFrames, ivec2(v, 0), 0);
            axisX = texelFetch(cornerFrames, ivec2(v, 1), 0).xyz;
            axisY = texelFetch(cornerFrames, ivec2(v, 2), 0).xyz;
        }
    }
    if (corner.w > 0.5) {
        vec3 offset = eyeCoordinate.xyz - corner.xyz;
        float cu = 0.5 + dot(offset, axisX) / stampMeters;
        float cv = 0.5 + dot(offset, axisY) / (v_width * metersPerPixel);
        if (cu > 0.0 && cu < 1.0 && cv > 0.0 && cv < 1.0) {
            // Symbol only: subtract the stamp's own line (its edge column at that row).
            vec4 symbol = max(textureLod(image, vec2(cu, cv), lod)
                - textureLod(image, vec2(0.0, cv), lod), 0.0);
            tex = symbol + tex * (1.0 - symbol.a);
        }
    }
}

// (shared block 2: un-premultiply, tint, discard, gamma)
material.emission = fragColor.rgb;   // emission, not diffuse (unlit line)
material.alpha = fragColor.a;
```

**Pitfalls:**
- **Don't** get `metersPerPixel` from `dFdx`/`dFdy` of `d`. `d` comes from the depth buffer,
  and its derivatives are noisy, which makes the X's speckled and broken. Use
  `czm_metersPerPixel(eyeCoordinate)`.
- **Don't** use plain `texture()` for the stamp. `u` jumps between stamps, so automatic mip
  selection breaks. Use `textureLod` with the explicit `lod` shown.
- **Don't** multiply the stamp size by `czm_pixelRatio`. `czm_metersPerPixel` already returns
  meters per CSS pixel, which is the same unit as `v_width`. Multiplying again stretches the
  stamp when the pixel ratio isn't 1. `czm_pixelRatio` belongs only in the `lod`, which counts
  device pixels.
- Divide by `stampPixels`, not `repeatPixels`, when computing `u`. Otherwise `spacing`
  stretches the stamp instead of adding a gap.
- In the stamp loop, skip neighbours whose `u` falls outside the open range (0, 1). Clamped
  samples there return the edge column, which would be layered on as if it were part of a
  stamp.
- Compute `sChange` (the `dFdx`/`dFdy` of `st.s`) before any branch. Derivatives inside
  non-uniform control flow are undefined. Outside the close-zoom path, `st.s` changes by at
  least 64 float steps per pixel, so a zero derivative only occurs in the wedge. In the
  close-zoom path, the wedge is detected as `d` falling outside the chosen segment's range.
- Every mode must leave the wedge as the edge column, including `CLIP`, which otherwise smears
  the clipped stamp's column across the wedge.
- `SNAP` and `FIT` divisions must be powers of two (`exp2(floor(log2(...)))`). Any other count
  makes stamps pop when the zoom level changes, because the coarser level's stamps are no
  longer a subset of the finer level's.
- Decide vertex overlap **per stamp**, using the stamp's `center`, not per fragment. Otherwise
  part of an X disappears and the rest stays.
- Include the line's **two ends** in the vertex list, so X's aren't cut off at the ends either.
- The material is inserted **before** Cesium's own polyline shader code. Don't try to read
  Cesium's varyings such as `v_endEcAndStartEcX`: redeclaring them is a GLSL error.

### 2.4 `setPositions(material, positions, width)` (CPU)

Set `material.lineWidth = width`. Then, for each consecutive pair of positions `i-1 → i`:

1. Build the geodesic with
   `new EllipsoidGeodesic(ellipsoid.cartesianToCartographic(p0), ellipsoid.cartesianToCartographic(p1), ellipsoid)`.
2. Read `length = geodesic.surfaceDistance` and skip the pair if `!(length > 0)`.
3. Push `{ geodesic, length, start, a: normalize(p0), b: normalize(p1) }`, where `start` is the
   running total of the previous segments' lengths.

Then set `uniforms.lineLength = Math.max(total, 1e-3)`, and set
`material.pendingVertexDistances = [0, ...each segment's start + length]`, which lists every
vertex including both ends. The wrapped `update` uploads it as the `vertexDistances` texture on
the next frame.

Finally, set `material.corners = computeCorners(material.segments)`. This holds one entry per
vertex, in the same order as the distances, as
`{ position, axisX, axisY, interior }` in world space:
- `position` is vertex `i`: the start of segment `i`, or for the last vertex, the end of the last
  segment. Use `pointAt`, from 2.6, at fraction 0 or 1.
- `interior = i > 0 && i < segments.length`. Only interior vertices get a corner symbol.
- `axisX = normalize(incoming + outgoing)`. These are the travel directions
  `directionAt(segments[i-1], 1)` and `directionAt(segments[i], 0)`, where `directionAt` is
  `normalize(pointAt(f + δ) - pointAt(f - δ))` with `δ ≈ 1 m`, clamped to 0..1. If the sum is
  nearly zero, the line doubles back, so use `incoming`.
- `axisY = normalize(cross(geodeticSurfaceNormal(position), axisX))`.

> `lineLength` must be the geodesic length. Cesium normalizes `st.s` by the line's arc length,
> and a wrong length stretches the stamps.

### 2.5 `updateCamera(material, camera)` (CPU, double precision)

**Why it's needed:** `st.s` is float32, so `d` only resolves to `lineLength × 2^-24`. That's
22 cm on a 3,600 km line, which smears the X's into a bar at 1 m zoom. Close up, the shader
therefore measures distance from reference points that the CPU computes exactly.

1. Set the threshold and modulus:
   ```js
   const step = uniforms.lineLength * 2 ** -24;
   uniforms.preciseMetersPerPixel = step * 64;              // PRECISE_STEP_FRACTION = 64
   // CSS pixels, like the shader's metersPerPixel.
   const repeatPixels =
     material.lineWidth * material.imageAspect * Math.max(uniforms.spacing, MIN_SPACING);
   const maxSpacing = 2 * repeatPixels * uniforms.preciseMetersPerPixel;
   const modulus = 2 ** Math.ceil(Math.log2(Math.max(2 * maxSpacing, 1e-3)));
   ```
   The modulus is a power of two that is at least 2× any spacing used in the precise path. That
   keeps the stamp-index parity (odd/even fade) consistent. It reads `spacing` every frame, so
   changing the uniform at runtime is safe.
2. For each segment, run `nearestPointOnSegment(segment, camera.positionWC)` (step 2.6) and keep
   the **two** with the smallest `distance`. Two segments are needed so corners near the camera
   work.
3. Call `setReference(uniforms.referenceA, uniforms.tangentA, uniforms.rangeA, first, camera, modulus)`,
   and the same for B with `second`. `setReference` does the following:
   - If there's no candidate, set `tangent.w = 0` and return.
   - `range.x = -fraction * segment.length` and `range.y = (1 - fraction) * segment.length`.
     These are the distances from the reference point back to the segment start and on to its
     end; the shader's vertex check uses them in the precise path.
   - `eye = Matrix4.multiplyByPoint(camera.viewMatrix, point)`.
   - `distanceAlong = segment.start + fraction * segment.length`.
   - `reference = (eye.x, eye.y, eye.z, distanceAlong % modulus)`.
   - `direction = normalize(Matrix4.multiplyByPointAsVector(camera.viewMatrix, tangent))`.
   - `tangent = (direction.x, direction.y, direction.z, 1)`.
   - Write the results with `Cartesian4.fromElements(..., result)` into the existing uniform
     objects.
4. **CORNER mode only** (`uniforms.vertexMode === VertexMode.CORNER`; otherwise set
   `nearCorner.w = 0`), `updateCornerFrames`:
   1. Reuse a `Float32Array(width * 3 * 4)`, where `width = corners.length`.
   2. For each vertex `v`, write these in eye coordinates:
      - texel `(v, 0)`: `viewMatrix × position`, with `w = interior ? 1 : 0`;
      - texel `(v, 1)`: `multiplyByPointAsVector(viewMatrix, axisX)`;
      - texel `(v, 2)`: the same for `axisY`.
   3. Of the interior vertices, find the one nearest the camera (smallest `|eye|`) and copy its
      three values into `nearCorner`, `nearCornerX` and `nearCornerY`.
   4. Set `material.pendingCornerFrames = { width, data }`; the wrapped `update` uploads it.

   This runs every frame because eye coordinates change with the camera. They're computed in
   double precision on the CPU, so they stay precise at close zoom.

### 2.6 `nearestPointOnSegment(segment, position)` (CPU)

1. **Great-circle first guess:**
   - `c = normalize(position)` and `n = normalize(cross(a, b))`.
   - `projected = c - dot(c, n) * n`.
   - `angle = atan2(dot(cross(a, projected), n), dot(a, projected))`.
   - `fraction = clamp(angle / angleBetween(a, b), 0, 1)`, using 0 if the segment angle is 0.
2. **Refine on the real geodesic**, 3 iterations:
   - `point = pointAt(fraction)`.
   - `tangent = normalize(pointAt(fraction + δ) - pointAt(fraction - δ))`, with
     `δ = min(1 / length, 0.5)` (about 1 m).
   - `fraction = clamp(fraction + dot(position - point, tangent) / length, 0, 1)`.
   - After the last iteration, recompute `point` and `tangent` at the final `fraction`.
3. `pointAt(fraction)`:
   - clamp `fraction` to 0..1;
   - call `geodesic.interpolateUsingFraction(...)`;
   - set the resulting cartographic's height to 0;
   - convert it with `Ellipsoid.WGS84.cartographicToCartesian`.
4. Return `{ point, tangent, fraction, distance: Cartesian3.distance(position, point) }`.

Use module-level scratch `Cartesian3`/`Cartographic` objects for temporaries. Allocate **new**
objects for the returned `point` and `tangent`.

---

## Step 3 — `src/solutions/worldSpace/PolygonPatternMaterial.js`

### 3.1 Behaviour to achieve

**The tile image** is a seamless 256×256 45° hatch. It fills the draped polygon as follows:

- **Anchoring:** the hatch is pinned to the ground, with square tiles aligned to east/north at
  the polygon's center.
- **Size:** tiles are about `tileSize` pixels on screen at every zoom. The shader blends between
  tiles of `2^k` and `2^(k+1)` meters.

**Approach:**
- **Don't** use `materialInput.st`.
- **Don't** use `positionToEyeEC` as the position. On a `GroundPrimitive` it comes from the depth
  buffer, which is too coarse: the hatch turns into blocks or a flat solid fill.
- Use only its **direction**, and intersect that view ray with a sphere fitted under the camera.

### 3.2 Uniforms

| name | JS initial value | meaning |
|---|---|---|
| `image`, `color` | from options (`Color.WHITE` default) | |
| `tileSize` | `48` default | target tile size in CSS pixels |
| `eyeToLocal` | `Matrix4.toArray(Matrix4.IDENTITY)` | eye coords → polygon east/north/up frame (**array**, not `Matrix4`) |
| `radius` | `Ellipsoid.WGS84.maximumRadius` | radius of the sphere under the camera |
| `cameraHeight` | `1` | camera height above that sphere (m) |
| `cameraUp` | `new Cartesian3(0, 0, 1)` | unit vector, sphere center → camera, local frame |
| `cameraHigh`, `cameraLow` | `new Cartesian2()` | camera east/north = `high + low` (float split) |

`TYPE = "PolygonPatternWorld"`. In `create()`:
- set `material.localToWorld = Matrix4.clone(Matrix4.IDENTITY)` and
  `material.worldToLocal = Matrix4.clone(Matrix4.IDENTITY)`;
- return `mipmapTexture(material, "image")`, which uses REPEAT wrap; the tiling depends on it.

### 3.3 Fragment shader, in this order

```glsl
// (shared block 1: placeholder discard)

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

float level = log2(tileSize * metersPerPixel);  // both per CSS pixel; no czm_pixelRatio here
float k = floor(level);                     // floor here (cross-fade between k and k+1)
float blend = level - k;
float size0 = exp2(k);
float size1 = size0 * 2.0;

vec2 uv0 = (mod(cameraHigh, size0) + p) / size0;
vec2 uv1 = (mod(cameraHigh, size1) + p) / size1;
vec4 tex0 = textureGrad(image, uv0, gradX / size0, gradY / size0);
vec4 tex1 = textureGrad(image, uv1, gradX / size1, gradY / size1);
vec4 tex = mix(tex0, tex1, blend);

// (shared block 2: un-premultiply, tint, discard, gamma)
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

### 3.4 `setOrigin(material, positions)` (CPU)

1. `center = Ellipsoid.WGS84.scaleToGeodeticSurface(BoundingSphere.fromPoints(positions).center, new Cartesian3())`.
2. `Transforms.eastNorthUpToFixedFrame(center, Ellipsoid.WGS84, material.localToWorld)`.
3. `Matrix4.inverseTransformation(material.localToWorld, material.worldToLocal)`.

### 3.5 `updateCamera(material, camera)` (CPU, double precision)

1. **Eye-to-local matrix:**
   - `modelView = camera.viewMatrix × material.localToWorld`, computed with `Matrix4.multiply`;
   - `eyeToLocal = Matrix4.inverseTransformation(modelView)`;
   - write it with `Matrix4.pack(eyeToLocal, uniforms.eyeToLocal)`.
2. **Sphere under the camera.** Refit it **every frame**; don't fit it at the polygon's center.
   - `nadir = Ellipsoid.WGS84.scaleToGeodeticSurface(camera.positionWC)`. Return early if this is
     undefined.
   - `up = ellipsoid.geodeticSurfaceNormal(nadir)`.
   - `radius = gaussianRadius(ellipsoid, nadir)` (step 3.6).
   - `centerWorld = nadir - up * radius`.
   - `center = Matrix4.multiplyByPoint(material.worldToLocal, centerWorld)`.
3. **Camera values:**
   - `eye = Matrix4.getTranslation(eyeToLocal)` is the camera in the local frame.
   - `fromCenter = eye - center` and `distance = |fromCenter|`.
   - Set `uniforms.radius = radius` and `uniforms.cameraHeight = distance - radius`.
   - Set `uniforms.cameraUp = fromCenter / distance`, writing into the existing object.
4. **Float split:**
   ```js
   uniforms.cameraHigh.x = Math.fround(eye.x);
   uniforms.cameraHigh.y = Math.fround(eye.y);
   uniforms.cameraLow.x = eye.x - uniforms.cameraHigh.x;
   uniforms.cameraLow.y = eye.y - uniforms.cameraHigh.y;
   ```

**Pitfall:** a sphere fitted at the polygon's center sits about 50 m below the real surface
1,000 km away. The pattern then lags the camera and looks stuck to the screen up close. The
symptom is `cameraHeight` reading about 50 m while the camera is actually 1 m above the ground.

### 3.6 `gaussianRadius(ellipsoid, surfacePoint)`

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

## Step 4 — Verify

Run `npm run dev`, then work through these checks. Use a real GPU. Chrome's software renderer
hides the precision bugs. For headless Chrome, launch with
`--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist`.

1. **Basic look at 15 km camera height:**
   - The polyline shows evenly spaced, upright, tall X's on a continuous line.
   - The polygon shows continuous 45° hatching with no seams.
   - Dragging a vertex updates both live.
2. **Zoom sweep, top-down, at 500 km, 60 km, 15 km, 3 km, 800 m, 150 m and 1 m:**
   - X spacing and hatch density stay roughly constant on screen.
   - No solid fills, no moiré.
3. **Tilted views (-25° to -40°):** the patterns foreshorten like paint on the ground, with no
   blocks or streaks.
4. **Continent-scale polyline:** it follows the Earth's curvature and never cuts through the
   globe.
5. **Max zoom on a large shape** (a polygon about 2,500 km across and a 3,600 km polyline):
   - Aim the camera at a point actually on the line by interpolating with `EllipsoidGeodesic`.
     Averaging the endpoints' longitude/latitude misses a 1 m view.
   - At 1 m height, step the camera 1 cm at a time. The pattern must move with the ground,
     about 7 px per cm for an 800 px-wide view. Check this with
     `SceneTransforms.worldToWindowCoordinates` on a fixed ground point.
   - The X's must stay crisp, not smear into a bar.
6. **No loading flash:** delay the pattern image request by about 1.5 s. New shapes must show
   nothing, not a solid block, until the image loads.
7. **Build:** `npm run build` passes.

## Symptom → cause cheat sheet

| Symptom | Likely cause |
|---|---|
| "uniform has invalid type" | Passed a `Matrix4` instead of an array |
| Dark outline around strokes | Missing un-premultiply |
| Moiré bands or solid hatch when zoomed out | `mipmapTexture` missing or not applied |
| Speckled or broken X's far away | `metersPerPixel` taken from derivatives instead of `czm_metersPerPixel` |
| Plain line with no gaps showing the line, or line missing between X's | `wrapS` isn't `CLAMP_TO_EDGE` |
| Hatch in blocks or streaks, or flat solid fill | Used the depth-based position instead of the ray-sphere intersection |
| Hatch moves with the screen at max zoom | Sphere not refit under the camera, or `cameraHigh` not wrapped with `mod` |
| X's smear into a bar at max zoom on long lines | Close-zoom reference-point path missing or wrong |
| Solid block flashes when a shape is created | Missing `textureSize <= 1` discard |
| Torn X or stray bracket shape at a corner, or half X at a line end | Missing vertex check (`nearestVertexGap` / `rangeA`/`rangeB`), or the wedge isn't forced to the edge column |
| Stamps pop at zoom changes in `SNAP`/`FIT` | Divisions not a power of two |
| Shader fails to compile mentioning `step` | A local variable named `step` (a GLSL built-in) |
| No corner symbol in `CORNER` mode | `cornerFrames` not uploaded, or size check `textureSize == (vertexCount, 3)` failing |
