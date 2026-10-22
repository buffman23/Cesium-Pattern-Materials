# Patch notes

Fixes to apply to a project that was built from `docs/IMPLEMENTATION_PLAN.md`. Each note says
which plan sections it changes, how to tell whether your build has the bug, and exactly what to
change. Apply them in order.

---

## 1. Stamps vanish near the camera when the nearest corner is on another segment

**Changes:** Step 5, `src/solutions/worldSpace/PolylinePatternMaterial.js`. Plan sections 5.2
(`nearVertex` row), 5.3 step 10.2, 10.3 and 10.5, and 5.5 steps 5–6.4.

### Symptom

At close zoom, the X's are missing along part of a polyline, but the line image is still drawn.
The X's come back further from the camera, where the shader leaves the close-zoom path. It
happens when the camera is over one segment and the interior vertex nearest the camera belongs
to a different part of the line.

To check your build, run this in the devtools console with `app.importState(...)`. Before the
fix, the line near the camera has no X's; after it, X's run from the bottom of the screen to the
horizon:

```json
{"solution":"worldSpace","lineWidth":24,"stampSpacing":0.34868591658760134,"maxHeightFactor":null,"maxHeightEaseFrom":19.027313840043536,"lineImage":"solid","stampImage":"x","canvas":[1365,953],"camera":{"lon":-105.8551319831791,"lat":42.30324136781927,"height":2312.6161806842083,"heading":1.732817358852209,"pitch":-0.30695809701307963,"roll":6.282921008388539},"shapes":[{"type":"polyline","positions":[[-108.2212285213407,42.6240051464207],[-94.46857356680134,40.007606103364196],[-92.03316213930283,44.25218702761076],[-107.39071094850753,46.52484307870059],[-105.7698092392668,49.922985108668186],[-92.37629767021947,48.000419061062615]]}]}
```

Here the camera is above segment 0 (vertices 0 and 1, 198 km and 988 km away). The nearest
*interior* vertex is vertex 3, 485 km away, which has nothing to do with segment 0.

### Cause

Plan 5.5 step 6.4 picks `nearVertex` as the interior vertex nearest the camera **out of all
vertices**. Plan 5.3 step 10.2 then uses it for every close-zoom fragment, as if it were an end
of that fragment's segment. For a fragment on segment 0, vertex 3's frame makes the
`pastOwnEnd` test (10.3) come out true, which turns off the segment's own stamps (10.4). The
corner stamps that replace them (10.5) are measured from vertex 3, so nothing is drawn. The line
layer doesn't use `pastOwnEnd`, so it keeps drawing.

There is a second, smaller problem in the same path. 10.3 decides "is the vertex at the
segment's end?" by comparing dv with the segment's ends, and 10.5 tests |d − dv| for reach. In
the close-zoom path, d and the segment's ends are the reference's w plus an offset, while dv is
`nearUp` w. Both are distances modulo the modulus, but they can differ by a whole multiple of
it (by as much as the distance from the reference point to the vertex), so those comparisons
are unreliable. The fix below stops comparing them.

### Fix, CPU side (plan 5.5)

1. In `updateCamera`, pass the two reference segments on to `updateVertexFrames` (step 6):

   ```js
   updateVertexFrames(material, camera, modulus, first?.segment, second?.segment);
   ```

   `first` and `second` are the two nearest-segment results from step 4. Either may be
   undefined.

2. In `updateVertexFrames(material, camera, modulus, segmentA, segmentB)`, step 6.4 only
   considers the **ends of those two segments**. Segment i joins vertices i and i + 1:

   ```js
   const candidates = [segmentA, segmentB]
     .filter(Boolean)
     .flatMap((segment) => [segment.index, segment.index + 1]);
   ```

   A vertex is a candidate for `nearVertex` only if it is interior **and** its index is in
   `candidates`. Still pick the one with the smallest eye-space distance.

3. Add four bits to `nearVertex` w, saying which end of which reference segment the vertex is:

   ```js
   const flags = 1 + (v === 1 ? 2 : 0) + (v === width - 2 ? 4 : 0) +
     (segmentA?.index === v ? 8 : 0) + (segmentA?.index === v - 1 ? 16 : 0) +
     (segmentB?.index === v ? 32 : 0) + (segmentB?.index === v - 1 ? 64 : 0);
   ```

   So 8 / 16 mean "starts / ends reference A's segment", and 32 / 64 the same for reference B.
   A corner shared by A and B gets one bit for each. `nearIncoming`, `nearOutgoing` and
   `nearUp` are unchanged.

### Fix, shader side (plan 5.3)

1. **Step 6 (close-zoom path):** also remember which reference was used. Declare
   `float nearVertexFlagBase = 8.0;` next to the other precise-path locals, and in the precise
   branch set it to 8.0 when using A, otherwise 32.0. That is the bit for "the vertex starts
   this fragment's segment"; twice it is "ends it".

2. **Step 10.2 (the nearest interior vertex):** add two locals to the defaults:
   `bool vertexAtEnd = false;` (the vertex ends this fragment's segment, otherwise it starts it)
   and `float vertexD = 0.0;` (the vertex's distance along the line in the same units as d).

   - **Precise path:** use `nearVertex` only if its w is above 0.5 **and** it is an end of this
     fragment's own segment:

     ```glsl
     bool startsOwn = mod(floor(nearVertex.w / nearVertexFlagBase), 2.0) > 0.5;
     bool endsOwn = mod(floor(nearVertex.w / (2.0 * nearVertexFlagBase)), 2.0) > 0.5;
     if (nearVertex.w > 0.5 && (startsOwn || endsOwn)) {
         haveVertex = true;
         vertexAtEnd = endsOwn;
         vertexD = endsOwn ? segmentEnd : segmentStart;
         // ... then everything the plan already reads from nearVertex and its companions,
         // including dv = nearUp.w
     }
     ```

     Keep dv = `nearUp` w for the corner stamps in 10.5. Those are measured from dv on both
     sides of the vertex, so they are self-consistent, and dv stays small, which keeps float
     precision at close zoom. Don't replace dv with vertexD there: vertexD can be as large as a
     segment's length, and at 1e6 m a float only resolves about 6 cm.

   - **Other path (vertex frames texture):** after choosing vertex index v from the segment's two
     ends, set `vertexAtEnd = v == segment + 1;` and `vertexD = dv;`. Here d and dv are already
     in the same units.

3. **Step 10.3 (past the vertex?):** delete the line that computes "the vertex is at the
   segment's end" from dv. Use the `vertexAtEnd` set in 10.2. The `pastOwnEnd` test itself is
   unchanged.

4. **Step 10.5 (stamps reaching across the vertex):** test reach with |d − vertexD| instead of
   |d − dv|. Everything else in 10.5, including the use of dv for "along" and the segment
   ranges, is unchanged.

Also update the `nearVertex` comment next to the uniform (and in your copy of plan 5.2) to
mention bits 8 / 16 / 32 / 64 and that the vertex is chosen from the reference segments' ends.

### Check

- The scene above shows X's from the bottom of the screen to the horizon.
- Corners still work at close zoom. Fly to a corner from the same scene, e.g.
  `app.viewer.camera.setView({ destination: app.viewer.camera.positionWC.constructor.fromDegrees(-94.46857, 40.00761, 300), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } })`
  (Cesium isn't a global in this app; `positionWC.constructor` is `Cartesian3`). The X's on
  both segments should reach the vertex whole, not torn, as before.

---

## 2. A line image off the centre line is cut off at sharp corners

**Changes:** Steps 1, 5 and 7: `public/patterns/line-bottom.svg` (new), `src/shared/testPatterns.js`,
`index.html`, `src/solutions/worldSpace/PolylinePatternMaterial.js` and
`src/solutions/worldSpace/renderer.js`. Plan sections 1.5, 5.1, 5.2 (`lineWidth`, `vertexFrames`
rows), 5.3 steps 5, 9–11, 5.4, 5.5 step 6.3 and 7.4. Apply note 1 first.

### Symptom

At a corner sharper than 60°, nothing is drawn past the vertex: both segments stop dead there.
With the Solid image you hardly notice, because its stroke runs down the middle of the line.
With a stroke along one edge, the stroke on the outside of the corner stops at the vertex
instead of wrapping around it. Corners of 60° or more are fine.

You need an image like that to see it. Add `public/patterns/line-bottom.svg`, a stroke along
the bottom edge:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="128" viewBox="0 0 64 128">
  <!-- Line image: a plain stroke along the bottom edge. Seamless (identical left and right edges). -->
  <rect x="0" y="116" width="64" height="12" fill="#ffffff" />
</svg>
```

Then add `bottom: "/patterns/line-bottom.svg",` to `LINE_IMAGES` in `src/shared/testPatterns.js`
(after `sawtooth`), and `<option value="bottom">Bottom</option>` after Sawtooth in the
`#lineImage` select in `index.html`.

To check your build, run this in the devtools console with `app.importState(...)`. The left end
of the narrow wedge is a 24° corner. Before the fix, the yellow stroke on the outside of the
corner stops at the vertex on both segments, leaving them unjoined. After it, both strokes run
on past the vertex and are joined by a short, straight stroke across the tip.

```json
{"solution":"worldSpace","lineWidth":100,"stampSpacing":1,"maxHeightFactor":null,"maxHeightEaseFrom":19.027313840043536,"lineImage":"bottom","stampImage":"x","canvas":[1132,735],"camera":{"lon":-111.6,"lat":40.3,"height":300000,"heading":6.283185307179586,"pitch":-1.5707949766148324,"roll":0},"shapes":[{"type":"polyline","positions":[[-102.6484095523123,40.25769961860955],[-112.0270756129037,40.03647178981267],[-103.21373026227396,43.0435555969553]]}]}
```

### Cause

`GroundPolylineGeometry` miters a corner by cutting both segments along the corner's bisector,
so they meet in a point. If the bisector is within 30° of a segment's direction (a corner of
60° or less, `MITER_BREAK_SMALL` in Cesium's `GroundPolylineGeometry.js`), it "breaks" the
miter: it rotates the cut 90°. Both segments then end on one line through the vertex, square
to the bisector, and nothing is drawn on its outer side. The shader can't draw outside the
geometry, so this needs extra geometry.

Don't try to fix it by giving the line a short bevel at the vertex (two extra points either
side of it). That seemed to work zoomed out, but:
- points closer than 1e-10 radians (about 0.6 mm) are merged as duplicates, so the bevel must
  be at least about a centimetre long;
- a segment that short gets a shadow volume that folds over on the corner's inner side. With
  the camera low (a few km, below the volume's top) and almost straight above the corner, the
  corner isn't drawn at all.

### The fix

Each sharp corner gets one more geometry instance in the same `GroundPolylinePrimitive`, with
the same material: a line from the vertex out along the bisector, twice as wide as the line.
The shader recognises those fragments by their width and draws the corner itself in eye space,
from the vertex frame it already uploads every frame. On the outer side of Cesium's cut, each
segment runs on up to a short bevel square to the bisector, half a line width out. Each part
shows the line image's column at the vertex (as a mitered wedge does) across its own direction,
and both segments' stamps are drawn over it. The look jumps at 60°: just wider, Cesium's
pointed miter; just sharper, this flat-tipped corner.

### Fix, CPU side (plan 5.4, 5.5)

1. Import `Math as CesiumMath` from `cesium`, and add these constants next to
   `REFINE_ITERATIONS`:

   ```js
   // GroundPolylineGeometry stops mitering corners that turn by more than this (a 60-degree corner).
   const CAP_TURN = CesiumMath.toRadians(120);
   // A corner cap's geometry is this many times as wide as the line, so the shader can tell its
   // fragments apart (and the cap's sides have room to spare).
   const CAP_WIDTH_FACTOR = 2;
   // A corner cap runs this fraction of the shorter adjacent segment out from the vertex: it must
   // reach half a line width, and the corner is only a few pixels across once it doesn't.
   const CAP_LENGTH_FRACTION = 0.25;
   ```

2. Add a uniform `lineWidth: 1` to the material's uniforms (after `lineLength`). In
   `setPositions`, after `material.lineWidth = width;`, also set
   `material.uniforms.lineWidth = width;`.

3. In `computeVertices`, give each vertex a `cap` flag after `interior`:

   ```js
   // GroundPolylineGeometry doesn't miter this corner; see cornerCaps.
   cap: Boolean(before && after) && Cartesian3.angleBetween(incoming, outgoing) > CAP_TURN,
   ```

4. In `updateVertexFrames` (plan 5.5 step 6.3), write w = 2 for those vertices in row 0:

   ```js
   data.set([eye.x, eye.y, eye.z, vertex.cap ? 2 : vertex.interior ? 1 : 0], v * 4);
   ```

   Everything that tests row 0's w for "interior" uses `> 0.5`, so 2 still counts as interior.

5. Add a static `cornerCaps(material)` after `setPositions`. Call it after `setPositions`:

   ```js
   static cornerCaps(material) {
     const ellipsoid = Ellipsoid.WGS84;
     const caps = [];
     material.vertices.forEach((vertex, v) => {
       if (!vertex.cap) {
         return;
       }
       const vertices = material.vertices;
       const length = CAP_LENGTH_FRACTION * Math.min(
         vertex.distance - vertices[v - 1].distance,
         vertices[v + 1].distance - vertex.distance,
       );
       const outward = Cartesian3.subtract(vertex.incoming, vertex.outgoing, new Cartesian3());
       Cartesian3.normalize(outward, outward);
       const end = Cartesian3.add(
         vertex.position,
         Cartesian3.multiplyByScalar(outward, length, outward),
         new Cartesian3(),
       );
       caps.push({
         positions: [vertex.position, ellipsoid.scaleToGeodeticSurface(end, end)],
         width: CAP_WIDTH_FACTOR * material.lineWidth,
       });
     });
     return caps;
   }
   ```

### Fix, renderer (plan 7.4)

1. Give `groundLine` a fifth argument, `extraLines = []` (`{ positions, width }` objects), and
   build one geometry instance per line, the main line first:

   ```js
   // `extraLines` ({ positions, width }[]) are drawn as further instances with the same material.
   function groundLine(positions, width, material, loop = false, extraLines = []) {
     const instance = (linePositions, lineWidth, lineLoop) =>
       new GeometryInstance({
         geometry: new GroundPolylineGeometry({
           positions: linePositions,
           width: lineWidth,
           loop: lineLoop,
           granularity: lineGranularity(linePositions, lineLoop),
         }),
       });
     return primitives.add(
       new GroundPolylinePrimitive({
         geometryInstances: [
           instance(positions, width, loop),
           ...extraLines.map((line) => instance(line.positions, line.width, false)),
         ],
         appearance: new PolylineMaterialAppearance({ material }),
         asynchronous: false,
       }),
     );
   }
   ```

2. In `buildPolyline`, pass the caps:

   ```js
   const caps = PolylinePatternMaterial.cornerCaps(state.material);
   replace(state, "primitive", groundLine(state.positions, lineWidth, state.material, false, caps));
   ```

### Fix, shader side (plan 5.3)

1. Add `uniform float lineWidth;` after `lineLength`, and the constant
   `const int MAX_VERTICES = 4096;` after `MIN_SPACING` (a loop bound for the vertex search).

2. **Step 5 (max height band):** work out the geometry's width first, and use it in place of
   `v_width` in the band and coverage:

   ```glsl
   // A corner cap's geometry is CAP_WIDTH_FACTOR times wider than the line (see the header).
   bool cap = v_width > 1.5 * lineWidth;
   float geometryPixels = cap ? lineWidth : v_width;
   float bandPixels = min(max(geometryPixels * sizeScale, 1.0), geometryPixels);
   float coverage = geometryPixels * sizeScale / bandPixels;
   ```

   Leave step 8's `t` using `v_width`: it's only used for the line itself.

3. **New step 9 (corner cap)**, after computing t. `st` means nothing in a cap fragment:

   ```glsl
   int capVertex = -1;
   vec3 capPosition = vec3(0.0);
   vec3 capIncoming = vec3(1.0, 0.0, 0.0);
   vec3 capOutgoing = vec3(1.0, 0.0, 0.0);
   vec3 capUp = vec3(0.0, 0.0, 1.0);
   float capDistance = 0.0;        // the vertex's distance along the line, same units as d
   float capLengthBefore = 0.0;
   float capLengthAfter = 0.0;
   if (cap) {
       if (vertexCount < 3.0 || textureSize(vertexFrames, 0) != ivec2(int(vertexCount), 4)) {
           discard;
       }
       // The cap vertex nearest this fragment.
       float nearest = 1e30;
       for (int i = 1; i < MAX_VERTICES; i++) {
           if (i >= int(vertexCount) - 1) {
               break;
           }
           vec4 frame = texelFetch(vertexFrames, ivec2(i, 0), 0);
           float away = length(eyeCoordinate.xyz - frame.xyz);
           if (frame.w > 1.5 && away < nearest) {
               nearest = away;
               capVertex = i;
           }
       }
       if (capVertex < 0) {
           discard;
       }
       capPosition = texelFetch(vertexFrames, ivec2(capVertex, 0), 0).xyz;
       capIncoming = texelFetch(vertexFrames, ivec2(capVertex, 1), 0).xyz;
       capOutgoing = texelFetch(vertexFrames, ivec2(capVertex, 2), 0).xyz;
       capUp = texelFetch(vertexFrames, ivec2(capVertex, 3), 0).xyz;
       // Zoomed in close, the vertex nearest the camera has its distances modulo the close-zoom
       // modulus, as d has; a float of the whole distance would be too coarse there.
       bool near = precise && nearVertex.w > 0.5 && length(nearVertex.xyz - capPosition) < 0.01;
       capDistance = near ? nearUp.w : vertexDistanceAt(capVertex);
       capLengthBefore = near ? nearIncoming.w
           : vertexDistanceAt(capVertex) - vertexDistanceAt(capVertex - 1);
       capLengthAfter = near ? nearOutgoing.w
           : vertexDistanceAt(capVertex + 1) - vertexDistanceAt(capVertex);

       // The line covers everything on the inner side of the cut (square to the bisector).
       vec3 offset = eyeCoordinate.xyz - capPosition;
       if (dot(offset, capIncoming - capOutgoing) <= 0.0) {
           discard;
       }
       // Each segment runs on up to its miter with the bevel, which lies between them, square
       // to the bisector (its direction is the mean of the segments').
       vec3 bevel = capIncoming + capOutgoing;
       bevel = length(bevel) > 1e-6 ? normalize(bevel) : normalize(cross(capUp, capIncoming));
       vec3 direction = dot(offset, capIncoming + bevel) < 0.0 ? capIncoming
           : dot(offset, bevel + capOutgoing) > 0.0 ? capOutgoing : bevel;
       float side = dot(offset, normalize(cross(direction, capUp)));
       if (abs(side) >= 0.5 * geometryPixels * metersPerPixel) {
           discard;
       }
       t = 0.5 + side / width;
       d = capDistance;
   }
   ```

   Don't name a variable `out` or `distance` here: `out` is a GLSL keyword and `distance` a
   built-in function.

4. **Step 10 (line layer):** don't clamp d in a cap; it's already the vertex's distance:

   ```glsl
   result = lineAt(cap ? d : clamp(d, segmentStart, segmentEnd), t, bandPixels, metersPerPixel);
   ```

5. **Step 11.2 (the nearest interior vertex):** before the precise-path branch, add a branch
   for caps, and turn the precise branch into an `else if`:

   ```glsl
   if (cap) {
       haveVertex = true;
       vertexPosition = capPosition;
       incoming = capIncoming;
       outgoing = capOutgoing;
       up = capUp;
       dv = capDistance;
       vertexD = capDistance;
       lengthBefore = capLengthBefore;
       lengthAfter = capLengthAfter;
       beforeStartsLine = capVertex == 1;
       afterEndsLine = capVertex + 2 >= int(vertexCount);
   } else if (precise) {
       // ... unchanged
   ```

6. **Step 11.3 (past the vertex?):** a cap lies wholly outside both segments' own bands, so
   it counts as past its own end. That skips the stamps placed by d (11.4) and draws both
   segments' stamps from the vertex frame (11.5):

   ```glsl
   bool pastOwnEnd = cap || (haveVertex
       && (vertexAtEnd ? dot(offset, incoming) > 0.0 : dot(offset, outgoing) < 0.0));
   ```

Also add a paragraph to the header comment of `PolylinePatternMaterial.js` explaining corner
caps, and update the `vertexFrames` comment (row 0 w: 2 if interior with a corner cap).

### Check

- The scene above shows the outer stroke running past the vertex and joined by a straight
  stroke across the tip.
- It still does with the line width set to 24 and the camera straight above the corner, low
  enough for the close-zoom path, e.g. 3 km and 30 m:
  `app.viewer.camera.setView({ destination: app.viewer.camera.positionWC.constructor.fromDegrees(-112.0270756, 40.0364718, 3000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } })`.
  The X over the corner is whole.
- Corners of 60° or more are unchanged (Cesium's own pointed miter), and corners just either
  side of 60° (say 58° and 62°) show no gap and no doubled edge.
