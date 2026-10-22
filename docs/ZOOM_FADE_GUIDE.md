# Zoom fades: nested polygon tiles and zoomSettle

This guide is for correcting a build whose polygon fill fades between zoom levels the wrong way,
and for matching `src/shared/zoomSettle.js`, which settles every fade once the camera stops. Part 1
is a plan an agent can follow step by step. Part 2 explains zoomSettle in detail, with its exact
numbers.

---

## Part 1. Plan: make the polygon fill's zoom levels nest

### What's wrong

With the Dots fill, zooming out shows **4 small dots around each big dot** while the big one fades
in (and the reverse zooming in). In the reference build, each big dot has **9 small dots** in the
2 × 2 tile area around it: one **centred on the big dot**, which simply grows into it, plus the 8
around it. Nothing jumps sideways, so the fade reads as the pattern thinning out rather than as
two unrelated patterns dissolving into each other.

### Why it happens

The shader draws the tile at two power-of-two sizes, `size0 = 2^k` meters and `size1 = 2 × size0`,
and cross-fades them. The fade only looks clean when every feature of the big tile sits exactly
on a feature of the small tile. That depends on **where the features are inside the tile
image**, and on both sizes sharing one origin.

- **Reference (`public/patterns/dots.svg`):** one dot on each **corner** of the 256 × 256 tile
  (quarter circles clipped by the viewBox). Small dots sit at every multiple of `size0`, big dots
  at every multiple of `2 × size0`. Every big dot is also a small-dot position, so the big
  dots are a subset of the small ones. Around each big dot, a 3 × 3 block of small dots: one
  shared centre plus 8 neighbours.
- **The incorrect version:** the dot at the tile's **centre** (128, 128). Small dots then sit at
  `size0 × (n + 0.5)` and big dots at `2 × size0 × (n + 0.5) = size0 × (2n + 1)`. Each big dot
  lands on a **corner between four small tiles**, where there is no small dot. That gives the
  "4 around 1" look, and the big dot has nothing to fade into.

The rule: **put the pattern's features on the tile's corners (or on its edges, for lines), not
its centre.** Then the lattice of the doubled tile is a subset of the lattice of the small one.

### Steps for the agent

1. **Replace the dot tile.** `public/patterns/dots.svg` must be exactly:

   ```svg
   <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
     <!-- Seamless dot tile: one dot on each corner (clipped by the viewBox), so repeated tiles form
          a square grid of whole dots. The dots of a tile twice the size land on dots of this one,
          so the zoom cross-fade between the two scales blends cleanly. -->
     <g fill="#ffffff">
       <circle cx="0" cy="0" r="44" />
       <circle cx="256" cy="0" r="44" />
       <circle cx="0" cy="256" r="44" />
       <circle cx="256" cy="256" r="44" />
     </g>
   </svg>
   ```

   Don't add a centre dot. It would be a feature of the small tile with no partner in the big one
   (the "4 around 1" problem again).

2. **Check the hatch tile nests too.** `public/patterns/hatch-45.svg` draws the lines x + y = 256
   (the main diagonal) plus the two half-diagonals in the opposite corners, x + y = 0 and
   x + y = 512, extended past the tile so the caps never show. In world terms the lines are at
   x + y = n × size, so the doubled tile's lines (n × 2 × size) are every second small line.
   A hatch drawn through the tile's centre at some other offset would not nest.

3. **Know that checkers can't fully nest.** A big checker square covers 2 × 2 small squares, and
   only 2 of the 4 match its colour. It still fades acceptably (the tile is 50 % filled at both
   sizes), but don't "fix" it by shifting squares: no offset nests better.

4. **Make both sizes share one ground origin.** In `PolygonPatternMaterial`'s shader, both
   samples must be anchored to the same local east/north origin, with the size being a power of
   two:

   ```glsl
   float level = log2(tileSize * metersPerPixel * sizeScale) + 0.5 + levelShift;
   float k = floor(level);
   float blend = smoothstep(0.8, 1.0, level - k);
   float size0 = exp2(k);
   float size1 = size0 * 2.0;

   vec2 uv0 = (mod(cameraHigh, size0) + p) / size0;
   vec2 uv1 = (mod(cameraHigh, size1) + p) / size1;
   vec4 tex0 = textureGrad(image, uv0, gradX / size0, gradY / size0);
   vec4 tex1 = textureGrad(image, uv1, gradX / size1, gradY / size1);
   vec4 tex = mix(tex0, tex1, blend);
   ```

   - `p` is the fragment's east/north position in meters **relative to the camera**, and
     `cameraHigh` + `cameraLow` is the camera's east/north position (`cameraLow` already added
     into `p`). `mod(cameraHigh, size)` is exact in float because `size` is a power of two, and
     wraps both sizes to the same origin. Multiples of `size1` are always multiples of `size0`.
   - Don't add any per-size offset (such as half a tile) to `uv0` or `uv1`. Don't compute the
     second sample as `uv0 * 0.5` from an origin other than the frame's.
   - `size1` must be exactly `2 × size0`. Any other ratio breaks the nesting.
   - Use `textureGrad` with the gradient divided by each size (mipmapped image, see
     `src/shared/mipmapTexture.js`). Plain `texture` on `fract`-wrapped coordinates gives seams
     at tile edges.

5. **Keep the fade window where the settle code expects it.** The polygon fades over
   `fract(level)` in **0.8 … 1.0** (`smoothstep(0.8, 1.0, …)`), and `updateCamera` passes
   `window: [0.8, 1]` to `updateZoomSettle` (Part 2). The `+ 0.5` on the level centres the tile on
   `tileSize`: a tile is between 2^−0.5 ≈ 0.71 × and 2^0.5 ≈ 1.41 × `tileSize` pixels on screen.

### Checks

- **Dots, zoom out slowly** (straight down at about 1,500 km, 48 px tiles): every big dot grows
  out of a small dot at the same centre while the 8 small dots around it fade. No dot moves
  sideways at any point.
- **Hatch, same zoom:** every second line thickens and the lines between fade out. No line
  appears halfway between two others.
- **Stop zooming mid-fade:** within about half a second the fill finishes the fade on its own
  (Part 2). It never rests half faded.
- **Pan at close zoom (1 m height):** the pattern stays locked to the ground, with no 6 cm jumps
  (that tests `cameraHigh` / `cameraLow` and the `mod`).

---

## Part 2. How zoomSettle works

### The problem it solves

Every pattern picks a power-of-two size from the zoom **level**, log2(pattern size in meters),
and cross-fades between two sizes while the level's fractional part is inside a **fade window**.
The level depends only on the camera height. So if the camera stops while the level is inside
the window, the pattern **rests half faded**: two sizes drawn at once, which looks blurry or
doubled.

The fix: once the camera height has stopped changing, add a small **level shift** to the layer
and animate it until the screen centre is just outside the window. The shift is one uniform
added to every pixel's level. The fade gradient across a tilted view just slides, and no seam
appears. While the height is changing the shift stays put, so fades follow the zoom exactly.

### Exact numbers

| constant | value | meaning |
|---|---|---|
| `REST_DELAY_MS` | **150 ms** | the height must stay unchanged this long before settling starts |
| height change test | **relative 1e-6** | the height "changed" if it moved by more than 1e-6 × itself since the last frame |
| `SPEED` | **0.3 levels per second** | how fast the shift moves (2^0.3 ≈ a 1.23 × change in pattern size per second) |
| `MARGIN` | **0.03 levels** | how far past the window edge the centre is pushed (about 2 % in size), so nearby pixels are out too |
| frame step cap | **0.1 s** | the most time one frame may advance the shift |
| first frame | **snap** | on the very first update the shift jumps straight to its target, so a page load never animates |

The fade windows, matching the shaders' `smoothstep` ranges:

| layer | window (`fract(level)`) | length with margins | farthest normal settle | worst-case time (incl. 150 ms delay) |
|---|---|---|---|---|
| polygon tile | **0.8 – 1.0** | 0.2 + 2 × 0.03 = **0.26 levels** | 0.13 levels → 0.43 s | **≈ 0.58 s** |
| polyline line image | **0.0 – 0.2** | **0.26 levels** | 0.13 levels → 0.43 s | **≈ 0.58 s** |
| polyline stamps (every second one fades) | **0.9 – 1.0** | 0.1 + 2 × 0.03 = **0.16 levels** | 0.08 levels → 0.27 s | **≈ 0.42 s** |

"Farthest normal settle" is half the window length: from a shift of 0, the code heads for the
**nearer** edge, so it never travels more than half the window. Over that distance the pattern
changes size by at most 2^0.13 ≈ 9 % (polygon, line) or 2^0.08 ≈ 6 % (stamps), slowly enough to
read as part of the fade rather than a jump. (If a shift from an earlier rest is still applied
and the level drifts back into the window, the nearer exit is measured from the current shift
and can be up to one window length away. That rare case takes up to 0.26 / 0.3 ≈ 0.87 s.)

### The algorithm, per frame

Each material owns a state from `createZoomSettle()`:
`{ height, lastChange, lastFrame, shifts: {} }`. Every frame its `updateCamera` calls
`updateZoomSettle(state, scene, layers)`, where `layers` maps a layer name to
`{ level, window }`, and adds the returned shift to that layer's level in the shader.

1. **Has the camera height changed?** Compare `camera.positionCartographic.height` with last
   frame's. If it moved by more than 1e-6 × itself, record `lastChange = now`.
2. **Step size:** `dt = min((now − lastFrame) / 1000, 0.1)` seconds, or 0 on the first frame.
   Frames stop while idle (`requestRenderMode`), so without the cap the first frame after a
   pause would jump the whole way.
3. **At rest?** `now − lastChange ≥ 150 ms`.
4. **For each layer:**
   - If not resting, leave its shift unchanged. This is what lets fades follow the zoom.
   - If resting, compute the target with `settledShift(level, shift, window)` (below). Move the
     shift toward it by at most `0.3 × dt` levels (or jump there on the first frame).
5. **Request another frame** while any shift hasn't reached its target, or while not yet at rest
   (so the frame that notices the rest happens). With `requestRenderMode`, frames would otherwise
   stop and the fade would freeze half way.

**The target, `settledShift`:**

- Widen the window by the margin on both sides: `[start − 0.03, end + 0.03]`, length `L`.
- `windowPosition(level)`: where `fract(level − (start − 0.03))` falls, 0 … L, or "outside"
  (`f > 0 && f < L` counts as inside). End values above 1 work, since everything goes through
  the fractional part.
- If `level + shift` is already **outside** the window, the target is the current shift. A
  pattern that's already clean is never touched.
- Otherwise take the **unshifted** level's position `f`. The two exits are `down = −f` and
  `up = L − f`. Pick whichever is nearer to the current shift. Measuring from the unshifted level
  keeps shifts below one window, so they never build up across rests.

### The level must be measured like the shader's

The settle code works on one level per layer, the one at the **screen centre**. That must match
what the shader computes for the centre pixel, or the centre settles outside the CPU's window
but inside the shader's.

- `referenceMetersPerPixel(scene)` casts the screen-centre ray at the ellipsoid
  (`camera.pickEllipsoid`). It takes the depth of that point along the view direction (or the
  camera height when the centre shows sky) and returns
  `camera.frustum.getPixelDimensions(drawingBufferWidth, drawingBufferHeight, depth, pixelRatio, …).y`.
  That's meters per **CSS** pixel, the same as the shaders' `czm_metersPerPixel`. It's cached per
  frame (keyed on `frameState.frameNumber`), since every material asks.
- Each material then builds its level exactly as its shader does:
  - polygon: `log2(tileSize × metersPerPixel × sizeScale) + 0.5`, window `[0.8, 1]`;
  - line image: `log2(lineWidth × lineAspect × metersPerPixel × sizeScale)`, window `[0, 0.2]`;
  - stamps: `log2(lineWidth × stampAspect × max(spacing, 0.25) × metersPerPixel × sizeScale)`,
    window `[0.9, 1]`.

  `sizeScale` is the max-height factor (below 1 above the max camera height). Apply it on both
  the CPU and the GPU.

### Common ways to get it wrong

- **Snapping the shift at rest.** The pattern visibly pops. It must animate at 0.3 levels/s.
- **Animating while the camera moves**, or using a time-based fade in the shader. Fades then lag
  or run ahead of the zoom. The shift must stay fixed while the height changes.
- **A per-pixel shift** (for example pushing each pixel out of its own window). Neighbouring
  pixels then pick different sizes and a seam appears. The shift is one uniform per layer.
- **Measuring the level from camera height** instead of meters per pixel at the screen centre.
  It's wrong for tilted views, and the centre can still rest inside the shader's window.
- **No margin** (0 instead of 0.03). The centre sits exactly on the window edge, so pixels just
  beside it are still partly faded.
- **Shifting toward the farther edge, or by a whole level.** That's a visible size jump of up to
  2×. Always take the nearer exit, measured from the unshifted level.
- **Not capping `dt`**, or not requesting frames while settling under `requestRenderMode`. The
  first causes jumps after a pause; the second leaves the fade frozen half way until the camera
  moves.
- **Window not matching the shader's `smoothstep`.** If the shader fades over 0.8–1.0 but the
  settle code is told `[0.75, 1]` or `[0, 0.2]`, the pattern rests half faded.
