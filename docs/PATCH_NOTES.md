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
