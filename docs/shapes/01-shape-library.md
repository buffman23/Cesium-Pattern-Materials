# Plan 01: Rebuild the shape library (`src/shapes/`)

A step-by-step plan for building, from an empty `src/shapes/` folder, a library for drawing and
editing geographic shapes on a CesiumJS globe. Plan 02 (`02-shapes-demo.md`) builds the demo
page on top of it; do this plan first.

## How to use this plan

- Work through the steps in order. Each step lists what to build, the behavior that matters,
  and a **Done when** check. Don't start a step until the previous one passes its check.
- The prose is the specification. Code blocks appear only for contracts (data shapes, signatures
  and constants) that other parts depend on exactly. Copy those exactly; write everything else
  your own way.
- Keep every exact name: file names, class names, method names, option names, field names,
  marker roles and keys, `static type` strings, JSON keys and user-facing strings. Other code,
  the demo and saved JSON depend on them.
- Comment each class with what it is and how the user interacts with it. Use `#private` methods
  for internals. Methods with an underscore (`_flush`, `_setMode`) are internal but called
  across classes.
- When the plan says "invalidate", it means call `this.invalidate(flags)`, never build
  primitives directly (see Step 6).

## 1. Goal

A library where an app creates one `ShapeEditor` per Cesium `Viewer`, then:
- starts drawing a shape type with options; the user clicks to place it
- edits the finished shape by dragging its markers (edit handles)
- reads and writes each shape's values through generic field descriptions (for forms)
- saves shapes to JSON and loads them back

Shape types: `Polyline`, `Polygon`, `Corridor` (all three built on `VertexShape`), `Circle`,
`Rectangle`, `Sector`, `Box`, `ParallelLines`.

Each shape can be **clamped to the ground** (draped on the globe) or drawn **at altitude**
(meters above the ellipsoid). Each edge follows the shape's **arc type**: `ArcType.GEODESIC`
(shortest path, the default) or `ArcType.RHUMB` (constant heading).

## 2. Prerequisites and fixed decisions

**Environment.** ES modules (`"type": "module"`), built with Vite. Dependencies:
`cesium` (^1.122.0) and `polygon-clipping` (0.15.7, for the corridor). The globe is the WGS84
ellipsoid with no terrain.

**Files that already exist. Import them as they are; don't rebuild them.**

| File | What the library uses |
|---|---|
| `src/solutions/worldSpace/PolylinePatternMaterial.js` | Default export, a class with static methods: `create(options)` → a Cesium Material (with a `loadingImages` Set), `setPositions(material, positions, widthPx)`, `cornerCaps(material)` → extra lines `[{ positions, width }]`, `updateCamera(material, scene)`. The material also has writable `maxHeight` and `heightTransition` properties. Options include `lineImage`, `stampImage`, `lineColor`, `stampColor`. Works only on `GroundPolylinePrimitive`, and assumes geodesic segments. |
| `src/solutions/worldSpace/PolygonPatternMaterial.js` | Default export with static `create(options)` → material (`loadingImages`, `maxHeight`, `heightTransition`), `setOrigin(material, positions)`, `updateCamera(material, scene)`. Options include `image`, `color`, `tileSize`. Works only on `GroundPrimitive`. |
| `src/shared/maxHeight.js` | `boundingBoxDiagonal(positions)` → meters; `fitMaxHeight(diagonal, camera, factor, easeFrom)` → `{ maxHeight, heightTransition }`. |

**Conventions used everywhere:**
- Bearings are radians clockwise from north. Distances are meters along the ellipsoid surface.
- **Signed sides:** positive means to the right of the direction of travel.
- **Field values use display units:** a position is `[lon°, lat°, height m]`, distances are
  meters and angles are degrees. Internally, positions are `Cartesian3` and angles are radians.
- **Copy positions.** Clone a position before storing it, and pass clones to Cesium geometry
  constructors, because some of them flatten their input positions in place.

## 3. Architecture overview

| Piece | Role |
|---|---|
| `ShapeEditor` | One per viewer. Owns input, the shape being drawn (`drawing`), the edited shape (`selected`), three shared scene collections (a `PrimitiveCollection`, a `PolylineCollection` for marker ground lines, a `BillboardCollection` for markers), and the once-per-frame rebuild. |
| `Shape` | Base class: common state, turns a subclass's geometry into primitives, the hook methods, fields, JSON, events. |
| `MarkerSet` | The billboards of one shape's markers. Exists only while the shape is in DRAW or EDIT mode. |
| Material specs | Descriptions that each shape turns into its own material instances. |
| `geodesy.js` | All geographic math, aware of the arc type. |

The flow: input → editor → shape hook → the shape changes its state and invalidates → before
the next render the editor calls `shape._flush()` → the shape rebuilds its fill and line
primitives and syncs its markers → the change events fire.

## 4. Contracts

These shapes are shared between files. Implement them exactly.

**Dirty flags** (exported from `Shape.js`):
```js
export const Dirty = Object.freeze({ FILL: 1, OUTLINE: 2, MARKERS: 4, GEOMETRY: 7 });
```

**Modes** (`ShapeMode.js`, default export):
```js
Object.freeze({ DRAW: "DRAW_MODE", EDIT: "EDIT_MODE", IDLE: "IDLE" })
```

**Outline line**, one entry of what `outlineLines()` returns:
```js
{ positions: Cartesian3[], loop?: boolean, key?: string, width?: number, arcType?: ArcType }
```

**Marker spec**, one entry of what `markerSpecs()` returns:
```js
{
  key: string,            // stable id across rebuilds, e.g. "v0", "anchor1", "translate"
  position: Cartesian3,   // where the billboard is drawn
  role: string,           // "vertex" | "translate" | "point" | "center" | "corner" | "radius" | ...
  index?: number, label?: number | string,
  deletable?: boolean,    // shows the red X when this marker is selected
  axis?: number,          // bearing a resize icon points along
  axisUp?: boolean,       // point the icon up instead
  vertical?: boolean,     // every drag on it changes height
  shiftVertical?: false,  // shift+drag is NOT a height drag for this marker
  shiftRole?: string,     // role whose look the marker takes while shift is held
  pixelOffset?: Cartesian2,
  // plus any subclass data (e.g. which: "max", flipped: true)
}
```

**Pick ids.** A marker billboard's id is `{ shape, key, kind: "marker" }`, the delete X's id is
`{ shape, key, kind: "delete" }`, and a primitive's id is `{ shape, part: "fill" | "outline" }`.

**Material spec and instance** (`materials.js`):
```js
// spec
{ isShapeMaterial: true, stateful, supportsAltitude, requiresGeodesicSegments,
  tint: Color, json?: object, create(): instance }
// instance
{ material: Cesium.Material,
  setLine?(positions, widthPx): extraLines[],  // outline instances
  setFill?(positions),                         // fill instances
  update?(scene),                              // every frame while visible
  loading?: boolean,                           // images still loading
  destroy() }
```

**Field descriptor**, one entry of `static fields`:
```js
{ name, label, type, min?, max?, options?, columns?, validate?(rows),
  show?(shape) => boolean, get(shape) => value, set(shape, value) }
// min / max may be functions of the shape.
// type: "position" | "positions" | "distance" | "angle" | "number" | "boolean" | "enum" | "table"
// table columns: { name, label, type: "longitude" | "latitude" | "distance" | "number", min?, max? }
```

**Draw-click result.** `onDrawClick(position)` returns `"continue"` or `"done"`.

**Change event payload.** `(shape, { fields: string[], source: "draw" | "drag" | "api", interactive: boolean })`.

**JSON**, what `shape.toJSON()` returns (common part):
```js
{ type, id, arcType: "GEODESIC" | "RHUMB", clampToGround, height,
  outline: { width, show, material: spec.json | null },
  fill: { show, material: spec.json | null },
  markers: { deletable, numbered, translatable, groundLine, pinSize, pinColor: cssString },
  properties, cursorMessages?: boolean,   // only when it's a boolean
  ...stateToJSON() }                      // the subclass's own keys
```
Positions in the subclass JSON are `[lon°, lat°, height]` arrays and angles are degrees.

## 5. Build steps

### Step 1: `ShapeMode.js`
Export the frozen mode object from §4 as the default export, with a comment explaining each
mode:
- DRAW: the user is placing the shape's points.
- EDIT: markers are shown and draggable (one shape at a time).
- IDLE: finished; click the shape to edit it.

**Done when** it imports.

### Step 2: `geodesy.js`
Pure functions on WGS84. Every function that follows a path takes an `arcType` (default
GEODESIC). Paths come from Cesium's `EllipsoidGeodesic` or `EllipsoidRhumbLine` between the two
cartographics. Export `ellipsoid` (`Ellipsoid.WGS84`) and these functions:

- `toCartographic(position, result?)`, `heightOf(position)`, `withHeight(position, height, result?)`
  (the same lon/lat at another height).
- `distance(a, b, arcType)`: surface distance, 0 for the same point (equal within 1 mm).
- `bearing(a, b, arcType)`: heading at a. `arrivalBearing(a, b, arcType)`: heading at b,
  continuing the same direction. Both are 0 for the same point.
- `destination(origin, bearing, meters, arcType, height?)`: the point that far along. Without
  `height` it keeps the origin's height; for 0 meters it returns the origin.
  - RHUMB: use `EllipsoidRhumbLine.fromStartHeadingDistance`. If that throws or returns an
    invalid latitude (a rhumb line can't pass a pole), fall back to the geodesic.
  - Geodesic: implement **Vincenty's direct formula** on WGS84 (a = 6378137,
    f = 1/298.257223563, iterate up to 100 times to 1e-12), because Cesium only provides the
    inverse problem. Normalize the result's longitude to (−π, π].
- `interpolate(a, b, fraction, arcType)`: the point a fraction along the path, with height
  interpolated linearly.
- `lineLength(positions, arcType, loop)`.
- `densify(positions, arcType, maxSegmentMeters, loop)`: keep the original vertices and insert
  points so no piece is longer than the limit, capped at 4096 pieces per segment. With `loop`
  the closing segment is densified and the result stops just before the first point again.
- `sampleArc(center, radius, fromBearing, toBearing, segments, arcType, height)`: `segments + 1`
  points from `destination(center, bearing_i, radius, …)`, with both ends included.
- `clockwiseSweep(from, to)`: the clockwise angle in [0, 2π).
- `crossTrackDistance(point, a, b, arcType)`: the signed distance across a → b, positive to the
  right. A spherical approximation (mean radius 6371008.8): asin(sin(d13/R)·sin(θ13 − θ12))·R,
  where d13 and θ13 are the geodesic distance and bearing from a to the point, and θ12 is the
  bearing of a → b by arcType.
- `offsetLine(centerline, offsetMeters, arcType, cornerType = MITERED)`: offset every point
  perpendicular to the direction of travel, positive to the right.
  - Ends use the start bearing / arrival bearing.
  - Inner corners are always mitered (offset × 1/cos(turn/2), capped at 4×).
  - Outer corners are mitered, beveled (two points), or rounded (arc points every 10°).
  - Returns a copy for fewer than 2 points or a 0 offset.
- `corridorOutline(centerline, width, arcType, cornerType = ROUNDED)`: a closed loop made of the
  right offset, an end cap (12 steps, a half circle when ROUNDED), the reversed left offset and
  the start cap.
- `rotatePositions(positions, from, to)`: rotate every position about the earth's center by
  the rotation that carries `from` onto `to` (both taken at height 0), keeping each position's
  height. Return copies when the angle is under 1e-12.
- `centroid(positions)`: the center of `BoundingSphere.fromPoints`, projected to the surface
  (fall back to the first point if that fails), at the average height. Undefined when empty.
- The detail table and granularity helpers. Copy these exactly:

```js
export const DEFAULT_DETAIL = {
  lineSegments: 256, minLineGranularity: 9999, maxLineGranularity: 200000,       // meters
  polygonCells: 32,
  minPolygonGranularity: CesiumMath.RADIANS_PER_DEGREE,
  maxPolygonGranularity: 5 * CesiumMath.RADIANS_PER_DEGREE,
  arcSegments: 256, interactiveFactor: 4,
};
// lineGranularity(positions, loop, detail, factor = 1)  (meters):
//   clamp(geodesicLength * factor / lineSegments, minLineGranularity, maxLineGranularity * factor)
// polygonGranularity(positions, detail, factor = 1)  (radians):
//   clamp((2 * boundingSphereRadius / ellipsoid.maximumRadius) * factor / polygonCells,
//         minPolygonGranularity, maxPolygonGranularity * factor)
```

**Done when** a Node script can import it and check these cases:
- `destination` from (0°, 0°) bearing 90° for 111 km lands near lon 1°, and `distance` back is
  within 1 m.
- `offsetLine` of an eastbound line at +1000 m lies south of it, about 1000 m away.

### Step 3: `liftedPolygon.js`
Polygon fills at altitude, which Cesium's `PolygonGeometry` gets wrong in Cesium 1.122:
- with per-position heights it doesn't subdivide, so the middle sags under the curved earth
- large polygons come out with every triangle twice, which doubles a translucent fill
- polygons 180° or more wide throw while computing texture coordinates

Export:
- `isWidePolygon(boundary, arcType)`: true when
  `PolygonGeometry.computeRectangleFromPositions` gives a width or height of π or more.
- `createPolygonGeometry(boundary, { granularity, arcType, height?, holes = [], heightAt? })` →
  a created `Geometry` with `position`, `normal` and `st` attributes, or undefined. Steps:
  1. Build a `PolygonGeometry` at height 0 from the rings moved to height 0, with
     `VertexFormat.POSITION_ONLY`, and call `PolygonGeometry.createGeometry`.
  2. Remove duplicate triangles: weld vertices by position and drop repeated triangles.
  3. Raise every vertex along its surface normal by a height:
     - `heightAt(position)` if given;
     - otherwise the fixed `height`;
     - otherwise one interpolated from the boundary's own heights. Triangulate the boundary in
       an `EllipsoidTangentPlane` and use barycentric weights in the containing triangle. A
       point slightly outside every triangle uses the best one with clamped, renormalized
       weights. Fall back to the average height.
  4. Set normals to the surface normal. Set texture coordinates by mapping the planar positions
     into 0..1 over the boundary's extent.
  5. Set the bounding sphere from the vertices.

**Done when** a 1000 km square at 5 km height builds without throwing, and every vertex's
height is about 5000 m.

### Step 4: `materials.js`
Implement the spec/instance contract from §4. Export:
- `DEFAULT_OUTLINE_COLOR = Color.WHITE.withAlpha(0.8)` and
  `DEFAULT_FILL_COLOR = Color.WHITE.withAlpha(0.25)`.
- `colorMaterial(color)`: stateless, supports altitude, `tint = color`,
  `json = { type: "color", color: cssString }`. `create()` makes a new Cesium "Color" material
  and destroys it in `destroy()`.
- `cesiumMaterial(material, { tint = WHITE, json })`: wraps an existing Cesium material.
  Stateless and supports altitude; `create()` returns it and `destroy()` does nothing (the
  material is shared and not owned).
- `patternLineMaterial(options, { json })`: stateful, `supportsAltitude: false`,
  `requiresGeodesicSegments: true`, tint = `lineColor ?? stampColor ?? white`.
  - It takes `maxHeightFactor` (default Infinity) and `easeFrom` (default 0) out of `options`
    and passes the rest to `PolylinePatternMaterial.create`.
  - Instance `setLine(positions, width)`: calls `setPositions`, remembers
    `boundingBoxDiagonal(positions)`, and returns `cornerCaps(material)`.
  - Instance `update(scene)`: applies `fitMaxHeight(diagonal, camera, factor, easeFrom)` to the
    material's `maxHeight` / `heightTransition`, then calls `updateCamera`.
  - `loading` is true while `material.loadingImages.size > 0`.
- `patternFillMaterial(options, { json })`: the same pattern for `PolygonPatternMaterial`.
  Stateful, `supportsAltitude: false`, `requiresGeodesicSegments: false`, tint = `color`, and
  `setFill(positions)` calls `setOrigin`.
- `toShapeMaterial(value)`: undefined/null → undefined; a spec as is; a `Color` →
  `colorMaterial`; a Cesium `Material` → `cesiumMaterial`; anything else throws.
- `altitudeFallback(spec)`: returns the spec when it supports altitude. Otherwise it warns once
  per spec in the console and returns `colorMaterial(tint)`, cached on the spec.
- `materialFromJSON(json, resolve)`: color JSON → `colorMaterial`; anything else →
  `resolve?.(json)`.

**Done when** `toShapeMaterial(Color.RED).create().material` is a Cesium material.

### Step 5: `Markers.js`
The marker look and the `MarkerSet` class.

**Images.** Every default image is an inline SVG data URI
(`data:image/svg+xml;charset=utf-8,` + encoded SVG), so the library needs no asset files. Each
SVG's intrinsic size is twice its drawn size, so it stays sharp on high-DPI screens.
- Square: a 24 px square, black, with a white 20 px inner square.
- `coloredMarkerImage(color)`: the same square with a colored inner square, cached per color.
- Delete X: a red (#e01b24) X, stroke 6, round caps, 36 px.
- Translate: four-way arrows, a white stroke over a wider black stroke, 44 px.
- Resize: a cyan (#29b6f6) vertical double-headed arrow with a dark outline, 44 px.
- Rotate: a white circular arrow with an arrowhead and a center dot, black outlines, 44 px.

Export `defaultMarkerImage`, `defaultDeleteImage`, `defaultTranslateImage`,
`defaultResizeImage`, `defaultRotateImage` and `coloredMarkerImage`, plus these color
constants: `RESIZE_COLOR = "#29b6f6"`, `ROTATE_COLOR = "#ffa726"`, `WIDTH_COLOR = "#ffeb3b"`.
Also export `numberedPinImage(text, color, size)`: a Cesium `PinBuilder.fromText` canvas,
cached by text, color and size.

**Options.** Copy these exactly:
```js
export const DEFAULT_MARKER_OPTIONS = Object.freeze({
  image: undefined, width: 12, height: 12, color: Color.WHITE,
  activeColor: undefined, hoverColor: undefined, scale: 1,
  deletable: false, deleteImage: undefined, deleteOffset: new Cartesian2(14, -14),
  numbered: false, pinColor: Color.fromCssColorString("#2d6cdf"), pinSize: 36,
  translatable: true, translateImage: undefined, groundLine: false,
});
export const DEFAULT_ROLE_STYLES = Object.freeze({
  width:    { image: RESIZE, width: 22, height: 22, align: true },
  radius:   { image: RESIZE, width: 22, height: 22, align: true },
  end:      { image: ROTATE, width: 22, height: 22 },
  start:    { image: ROTATE, width: 22, height: 22 },
  rotate:   { image: ROTATE, width: 22, height: 22 },
  altitude: { image: RESIZE, width: 22, height: 22, align: true },
});
```
`mergeRoleStyles(...tables)` merges per role, left to right: an entry's properties override the
earlier ones, and a `null` entry removes that role's style.

**Image ids.** Billboards share one texture-atlas entry per image. Use the URL string as the
atlas id, or a GUID stored in a WeakMap for image and canvas objects. Only call
`billboard.setImage(id, image)` when the id changes.

**`MarkerSet` (class, exported).** It's constructed with `(editor, shape)` and tracks:
- billboards by key, specs by key, and ground lines by key
- `hoverKey`, `selectedKey` (whose X shows) and `activeKey` (being dragged)
- one delete billboard, shared by all of the shape's markers

Methods:
- `spec(key)`.
- `loading`: true while any billboard (or the shown X) isn't `ready`.
- `sync(specs)`: create, move or remove billboards to match the specs by key.
  - New billboards get `disableDepthTestDistance = Infinity`, a centered origin and the marker
    pick id.
  - Style each marker and sync its ground line.
  - Clear `selectedKey` / `hoverKey` when their marker is gone.
  - Sync the X and request a render.
- `setHover(key)`: hovering a marker also makes it the selected one (its X shows), and moving
  off it keeps the X, so the pointer can reach the X. Restyle the old and new marker, then sync
  the X.
- `setSelected(key)`, `setActive(key)`, `restyleAll()` and `destroy()` (remove everything).

**Styling a marker** follows these rules:
1. The look role is `spec.shiftRole` while the editor's `shift` is held, otherwise `spec.role`.
2. Pick the image and size:
   - `"translate"`: the translate image (option or default) at 22×22.
   - Else, if a role style exists for the look role: its image, size defaulting to 22.
   - Else, a numbered pin when `numbered` is on and the spec has a `label`: the pin at
     `pinSize`, anchored at the bottom.
   - Else the marker image (option or default) at the `width` / `height` options.
3. If the role style has `align: true`, set `alignedAxis`:
   - with `axisUp`: the surface normal;
   - otherwise with `axis`: the world vector pointing along that bearing (east·sin + north·cos
     in the local frame; at a pole use any east);
   - otherwise zero.
   Without `align`, `alignedAxis` is zero.
4. Size: width and height times `scale`. Use `pixelOffset` from the spec.
5. Color:
   - Role-styled markers and pins are white (untinted); other markers use `color`.
   - `activeColor` applies while the marker is dragged and `hoverColor` while it's hovered;
     both are off by default.

**The delete X.**
- Shows for the selected marker when its spec is `deletable` and nothing is being dragged.
- Size 18×18 × scale. Offset `deleteOffset` × scale, or (pinSize·0.5, −pinSize·0.85) × scale on
  a pin.
- Its id is `{ shape, key, kind: "delete" }`.

**Ground lines.** With `groundLine` on and the shape not clamped, each marker gets a 1 px
white (60 % alpha) line straight down to height 0, in the editor's `PolylineCollection`.

**Done when** it imports, and `mergeRoleStyles(DEFAULT_ROLE_STYLES, { radius: null }).radius`
is undefined.

### Step 6: `Shape.js`
The base class, plus these exports: `Dirty`, `validateField`, `fieldPosition`, `toDegrees`,
`fromDegrees` and `clonePositions`.

**Registry.**
- A module-level Map. `static register(Class)` stores the class under `Class.type` and returns
  it.
- `static classFor(type)` returns the class for a type name.
- `static fromJSON(json, { resolveMaterial })`:
  1. Look up the class by `json.type`; throw `Unknown shape type "…"` if it isn't registered.
  2. Rebuild the marker options, turning the `pinColor` CSS string back into a Color.
  3. Construct with the common options. Materials come from `materialFromJSON(…,
     resolveMaterial)`; `arcType` is from its string.
  4. Spread `Class.stateFromJSON(json)` into the options.

**Statics.**
- `type = "Shape"`, `hasFill = true`, `defaultMarkerOptions = {}`, `stateFromJSON() → {}`.
- Base `fields`:
  - `arcType`: enum `["GEODESIC", "RHUMB"]`.
  - `clampToGround`: boolean.
  - `height`: distance, min 0.

**Constructor options and defaults.**

| Option | Default | Notes |
|---|---|---|
| `id` | `shape-<n>` | n is a module counter |
| `arcType` | GEODESIC | |
| `clampToGround` | false | |
| `height` | 0 | |
| `outline` | `{ material: DEFAULT_OUTLINE_COLOR, width: 2, show: true }` | material through `toShapeMaterial` |
| `fill` | `{ material: DEFAULT_FILL_COLOR, show: true }` | |
| `lineMaterials` | `{}` | per line key, through `toShapeMaterial` |
| `markers` | | `markerOptions` = DEFAULT_MARKER_OPTIONS, then the class's `defaultMarkerOptions`, then this option. `roleStyles` merged with `mergeRoleStyles(DEFAULT_ROLE_STYLES, class's, option's)` |
| `detail` | `DEFAULT_DETAIL` | merged |
| `show` | true | |
| `properties` | `{}` | free user data, saved in JSON |
| `cursorMessages` | true | true, false, or a function `(shape) => text` |

The constructor also creates two Cesium `Event`s: `changed` and `modeChanged` (raised with
shape, mode, previous). It starts IDLE, fully dirty, with no editor and no markers.

**Mode methods.**
- `mode` (getter).
- `finishDrawing()`: only in DRAW. If the shape isn't valid, `cancelDrawing()`; otherwise tell
  the editor (`editor._finishedDrawing(this)`).
- `cancelDrawing()`: removes the shape if it's in DRAW.
- `edit()` (the editor selects it), `stopEditing()` and `remove()`.
- `_setMode(mode)`:
  - Leaving for IDLE destroys the MarkerSet; any other mode creates one if missing.
  - Always resets the interactive flag.
  - Invalidates GEOMETRY when leaving DRAW (to rebuild at full detail), otherwise MARKERS.
  - Raises `modeChanged`.
- `interactive`: true in DRAW or while dragging. `_setInteractive(on)` invalidates GEOMETRY when
  it turns off. `detailFactor` is `detail.interactiveFactor` while interactive, otherwise 1.

**Setters.** Each one sets state and invalidates the right flags:
- `setArcType`, `setClampToGround`, `setHeight` (min 0): GEOMETRY.
- `setOutlineMaterial`, `setLineMaterial(key, m)`, `setOutlineWidth`, `setOutlineShow`: OUTLINE.
- `setFillMaterial`, `setFillShow`: FILL.
- `setMarkerOptions(options)`: merges `roleStyles` with `mergeRoleStyles` and the rest with
  assign, restyles all markers, and invalidates MARKERS.
- `setCursorMessages(v)`: asks the editor to update the cursor message.
- `show` (getter/setter): toggles the primitives' `show` directly and requests a render.

**Other methods.**
- `currentCursorMessage()`: false → undefined, a function → its result, otherwise
  `cursorMessage()`.
- `pointHeight`: 0 when clamped, otherwise `height`. `atPointHeight(p)` returns p at that height.

**Fields.**
- `fields` (getter): the class's fields that pass `show(shape)`, with `min` / `max` resolved when
  they're functions.
- `getField(name)`: the `get` result, or null. Throws `<type> has no field "<name>".` for an
  unknown name.
- `getFields()`: an object of every field's value.
- `setField(name, value)`: runs `validateField`, then `set`, then returns `getField`.

`validateField(field, value)` normalizes and throws readable messages:
- **number, distance, angle:** must be finite (strings are trimmed; a blank string is invalid),
  then clamped to min/max.
- **boolean:** coerced.
- **enum:** must be one of `options`.
- **position:** must be an array of length 2 or 3. Latitude must be in −90..90, longitude is
  wrapped into −180..180, and a blank height is 0.
- **positions:** a list of positions, with min/max counts enforced.
- **table:** rows checked column by column (latitude range, longitude wrapped, clamped to the
  column's min/max), then `field.validate(rows)` if present.

Messages read like "Center latitude must be between -90 and 90.", "Vertices needs at least 3
entries." and "Radius must be a number."

`fieldPosition(p)` → `[lon, lat, height]` with degrees rounded to 1e-10 and height to 1e-4, so
round-trip noise doesn't count as a change. `toDegrees(p)` (unrounded) and
`fromDegrees([lon, lat, h = 0])` convert between the two forms.

**Invalidate.** `invalidate(flags = GEOMETRY)` ORs the flags into `_dirty` and calls
`editor._requestFlush(this)` if the shape has an editor.

**Hooks with defaults.** Subclasses override these:

| Hook | Default |
|---|---|
| `getControlPoints()` / `setControlPoints(points)` | `[]` / no-op |
| `isValid()` | false |
| `onDrawClick(position)` | `"done"` |
| `onDrawMove(position)` | no-op |
| `onDrawFinishRequest(kind)` | right-click cancels |
| `drawHint()` / `cursorMessage()` | `""` / undefined |
| `markerSpecs()` | `[]` |
| `onMarkerDrag(spec, position, { shift })` | no-op |
| `onMarkerDragEnd(key)` | no-op |
| `onMarkerHeight(spec, height, { shift })` | `setHeight(height)` |
| `markerHeight(spec)` | the height of `spec.position` |
| `deleteMarker(spec)` | false |
| `createFillGeometry()` | undefined |
| `outlineLines()` | `[]` |
| `stateToJSON()` | `{}` |

**Translate.**
- `translate(from, to)`: `setControlPoints(rotatePositions(getControlPoints(), from, to))`,
  then invalidate GEOMETRY.
- `translateAnchor()`: the centroid of the control points, at point height.
- `translateSpec(position = translateAnchor())`: returns
  `[{ key: "translate", position, role: "translate" }]`, but only in EDIT with `translatable`
  on and a position available; otherwise `[]`.

**`polygonGeometry(boundary, { holes = [], arcType = this.arcType })`**, a helper for
subclasses:
1. Return undefined for fewer than 3 distinct points (within 1 cm).
2. Clone the boundary and holes, and remember the boundary as `_fillPositions`. The fill
   material's `setFill` and the bounding sphere use it.
3. Granularity is `polygonGranularity(boundary, detail, detailFactor)`.
4. If the polygon is wide (`isWidePolygon`) and RHUMB, densify the boundary along the rhumb line
   (pieces of granularity × maximum radius) and switch to GEODESIC, because Cesium 1.122 hangs
   on wide rhumb polygons.
5. At altitude, return `createPolygonGeometry`, with `height` when every boundary height is
   equal within 1 mm, and the holes.
6. On the ground, return a plain `PolygonGeometry` with a hierarchy and holes, using the
   textured vertex format of `MaterialAppearance`.

**Rendering.** All of this happens in `_flush()`, called by the editor:
1. Clear `_dirty` and return early if there's no editor.
2. On FILL, rebuild the fill:
   - Remove the old primitive.
   - If `hasFill`, `fill.show` and a material are all set, collect
     `[createFillGeometry()].flat().filter(Boolean)`.
   - Get a material instance for key `"fill"`, using `altitudeFallback(spec)` when not clamped.
     An instance is reused while its spec is the same object; otherwise the old one is destroyed
     and a new one created.
   - Call `instance.setFill?.(_fillPositions, or the control points)`.
   - Build a `GroundPrimitive` (clamped) or a `Primitive` (altitude), with
     `MaterialAppearance({ material, materialSupport: TEXTURED, translucent: true, flat: true })`,
     `asynchronous: false`, and instance ids `{ shape, part: "fill" }`.
   - Destroy unused fill instances.
3. On OUTLINE, rebuild the lines. When `outline.show` is on:
   - Group `outlineLines()` by `key` (default `"outline"`), skipping lines with fewer than 2
     distinct points.
   - Each group's material is `lineMaterials[key] ?? outline.material`, with `altitudeFallback`
     at altitude.
   - **Stateless material:** one instance (`line:<key>`) and one primitive for the whole group.
   - **Stateful material:** one instance per line (`line:<key>:<i>`) and one primitive per line.
     The positions are prepared first: a loop is closed by repeating the first point, and when
     the material requires geodesic segments and the shape is RHUMB, the line is densified
     along the rhumb line (pieces of max(length/256, 500 m)). Call `setLine`, and draw its extra
     lines in the same primitive. When the material requires geodesic segments, the arc type is
     GEODESIC.
   - Clamped lines: `GroundPolylinePrimitive` with `GroundPolylineGeometry` (granularity from
     `lineGranularity`).
   - Lines at altitude: `Primitive` with `PolylineGeometry`. Close loops by repeating the first
     point, use `PolylineMaterialAppearance.VERTEX_FORMAT`, and granularity 1° × detailFactor.
   - Always `asynchronous: false`, with ids `{ shape, part: "outline" }`. Collect all line
     positions into `_linePositions`, and destroy unused line instances.
4. On FILL or OUTLINE, set `boundingSphere` from the fill and line positions (undefined if there
   are none).
5. On MARKERS, if markers exist, `markers.sync(markerSpecs())`.
6. Request a render.
7. Compute the change payload:
   - `fields`: compare `JSON.stringify(get(shape))` of every current field with the snapshot
     from the previous flush (every field counts as changed on the first flush).
   - `source`: `"draw"` in DRAW, `"drag"` while interactive, otherwise `"api"`.
8. Raise `this.changed` and `editor.shapeChanged` with it.

`_updateFrame(scene, cullingVolume)` runs every frame:
- Skip if hidden or no instances.
- Call `instance.update(scene, shape)` for instances that have it, but only while
  `boundingSphere` is in view.
- Return true if any instance is still `loading`.

`_destroyRender()` removes the primitives, destroys every instance and destroys the markers.

**`toJSON()`** follows §4.

**Done when** `Shape.js` imports and `validateField({ type: "position", label: "P" }, [200, 10])`
returns `[-160, 10, 0]`.

### Step 7: `ShapeEditor.js`
**Creation.**
- `static async create(viewer, options)` awaits `GroundPrimitive.initializeTerrainHeights()`
  first, so ground primitives can be built synchronously.
- The constructor takes `{ cursorMessage: { show = true, offset = {x:16, y:16}, className } }`
  and sets up:
  - state: `shapes`, `selected`, `drawing`
  - Cesium Events: `shapeAdded`, `shapeRemoved`, `selectionChanged (shape, previous)`,
    `hint (text)`, `shapeChanged`
  - the three scene collections (§3)
  - input
  - `preRender` / `postRender` listeners

**Shape management.**
- `add(shape)`: sets the editor, pushes the shape, invalidates it and raises `shapeAdded`.
  Shapes start IDLE.
- `remove(shape)`:
  - deselect it if selected; clear `drawing` and the hint if it was being drawn; end its drag
  - `_destroyRender()`, then drop it from the dirty set and from `shapes`
  - unset its editor and raise `shapeRemoved`
- `clear()`: cancels drawing, then removes every shape.
- `startDrawing(Class, options)`: cancels any current drawing, deselects, adds
  `new Class(options)`, sets `drawing`, forgets the last click, puts the shape in DRAW, emits
  its `drawHint()`, updates the cursor message, and returns the shape.
- `select(shape)`:
  - Ignored if the shape is already selected, belongs to another editor, or is in DRAW.
  - The previous shape goes IDLE and the new one goes EDIT.
  - Emits the hint: "Drag the markers to edit (shift+drag changes height at altitude). " +
    (for `insertOnDoubleClick` classes, `static insertHint` or "Double-click an edge to add a
    vertex. ") + "Click elsewhere or press Esc to stop editing."
  - Raises `selectionChanged`.
- `deselect()`: the shape goes IDLE, the canvas cursor resets, and the hint becomes "Click a
  shape to edit it, or pick a tool to draw another." Raises `selectionChanged(undefined,
  previous)`.
- `destroy()`: clears everything and removes all listeners.

**Methods shapes call.**
- `metersPerPixelAt(position)`: `camera.getPixelSize(new BoundingSphere(position, 0),
  drawingBufferWidth, drawingBufferHeight)` × (drawingBufferHeight / canvas.clientHeight).
- `_requestFlush(shape)`: adds the shape to the dirty set and requests a render.
- `_finishedDrawing(shape)`: clears `drawing`, sets the shape IDLE, selects it, and updates the
  cursor message.
- `shift` (getter).

**Picking positions.** `pickPosition(windowPosition, height = 0)` uses
`camera.pickEllipsoid` on WGS84 grown by `height` on every axis, so a marker at altitude stays
under the cursor. Cache the grown ellipsoids in 10 cm buckets and clear the cache past 64
entries. The result is set to exactly `height`.

**Input.**
- Remove the viewer's default LEFT_DOUBLE_CLICK action.
- Create a `ScreenSpaceEventHandler` and register every action twice: without a modifier and
  with `KeyboardEventModifier.SHIFT`. Cesium only fires the actions registered for the held
  modifier.
- Track shift with window `keydown` / `keyup` / `blur`. Change it only on a real change, then
  restyle the selected shape's markers and request a render.
- Esc cancels drawing, or else deselects.
- Canvas `mouseenter` / `mouseleave` toggle whether the cursor message may show.

`#pickedId(windowPosition)`:
- Run `scene.pick` and keep the id only if `id.shape` is a Shape of this editor.
- If it hit a marker or delete X, `drillPick` (limit 6). When two or more handles of the same
  shape are under the cursor, choose the one whose drawn center is nearest the cursor: its screen
  position plus its `pixelOffset`, or the delete billboard's offset for an X.

Left click:
- **While drawing:**
  - Ignore a click within 4 px of the previous draw click; this swallows the second click of a
    double-click.
  - Pick at `shape.pointHeight` and remember the click.
  - Call `onDrawClick`. `"done"` → `finishDrawing()`; otherwise re-emit `drawHint()` if the
    shape is still being drawn.
  - Update the cursor message.
- **Otherwise:**
  - Ignore the click that ends a drag that moved.
  - Nothing picked → remember `{ shape: selected, time: now }` as "last deselected" (see double
    click), then deselect.
  - A delete X → if `deleteMarker(spec)` returns true, clear hover and selection on the markers.
  - A marker → `setSelected(key)`.
  - A shape → `select(shape)`.

Double click:
- While drawing → `drawing.onDrawFinishRequest("double")`.
- Otherwise, ignore if a marker or X is under the cursor.
- Candidates, in order:
  1. the selected shape
  2. the picked shape
  3. the "last deselected" shape, if under 600 ms ago (a missed first click on a thin line still
     counts)
- For the first candidate whose class has `insertOnDoubleClick` and whose
  `vertexInsertAt(scene, position, 8)` hits: select it, `insertVertex(hit.index, hit.position)`,
  set the selected marker to `v<index>`, and request a render.

Right click while drawing → `onDrawFinishRequest("right")`.

Left down:
- Only with a selected shape and not drawing, on one of that shape's markers.
- Start a drag:
  `{ shape, key, height: clamped ? 0 : shape.markerHeight(spec), last: pickPosition(position, height) ?? spec.position, moved: false }`.
- Disable camera input, set the shape interactive, select the marker and set it active, and hide
  the cursor message.

Mouse move:
- Record the cursor position, mark the cursor as inside, and update the cursor message.
- If dragging, apply the drag (below).
- Else if drawing, pick at `pointHeight` and call `onDrawMove`.
- Else hover. Pick at most once per animation frame.
  - Hovering one of the selected shape's markers or its X calls `setHover(key)`; anything else
    calls `setHover(undefined)`.
  - Canvas cursor: "move" on the translate marker, "grab" on other markers, "pointer" on a
    shape, otherwise the default.

Applying a drag:
- Set `moved`, and pass `{ shift }` as modifiers.
- It's a vertical drag when `spec.vertical`, or when shift is held and
  `spec.shiftVertical !== false`.
- **Vertical drag, shape not clamped:** `height = max(height + pixelsUp × metersPerPixelAt(spec.position), 0)`,
  then `onMarkerHeight(spec, height, modifiers)`.
- **Otherwise:** pick at the drag height and skip if nothing is picked. A translate marker calls
  `shape.translate(last, position)`; any other marker calls `onMarkerDrag(spec, position,
  modifiers)`. Then set `last` to the position.

Left up ends the drag:
- Re-enable camera input, call `onMarkerDragEnd(key)`, clear the active marker, and unset
  interactive.
- If the drag moved, swallow the click that follows, using a flag reset by `setTimeout(0)`.

**Cursor message box.**
- A `position: fixed` div appended to the viewer container. It's created lazily, has
  `pointer-events: none` and `white-space: pre-line`, and so supports multi-line messages.
- Without a custom `className` it gets the built-in look: dark translucent box, white 12 px
  text, 4 px radius, max width 260 px.
- It shows `(drawing ?? selected).currentCursorMessage()` only while the cursor is inside the
  canvas and not dragging.
- It's placed at cursor + offset, and flips to the other side of the cursor when it would leave
  the canvas.

**Frame loop.**
- `preRender`:
  1. Flush every dirty shape once, from a copy of the dirty set.
  2. Compute the camera's culling volume.
  3. Call `_updateFrame` on every shape.
  4. Remember whether any material, or the drawing / selected shape's markers, is still loading.
- `postRender`: request another render while something is loading or shapes are dirty. That
  makes `requestRenderMode` work.

**Done when** the module imports. (It needs a browser to run, so it's tested in Step 8.)

### Step 8: `VertexShape.js`, `Polyline.js`, `Polygon.js`
**`VertexShape extends Shape`.**
- Statics: `minVertices = 2`, `singleHeight = false`, `insertOnDoubleClick = false`,
  `closed = false`, `defaultMarkerOptions = { deletable: true }`.
- Fields: the base fields plus `positions` (type positions, label "Vertices", min =
  `minVertices`).
- State: `positions` (cloned from the option) and a floating vertex under the cursor while
  drawing.
- JSON: `{ positions: [[lon, lat, h], …] }`.
- `drawPositions()`: the vertices plus the floating vertex, each mapped to where it's drawn:
  - clamped → height 0
  - `singleHeight` → the shape's `height`
  - otherwise → the vertex's own height
- `setPositions` / `setVertex(i, p)` (throws RangeError out of range).
- `removeVertex(i)`: refuses (returns false) at `minVertices`; otherwise removes the vertex and
  returns true.
- `insertVertex(i, p)`: inserts before `i`.
- Control points are the positions.
- `setHeight(h)`:
  - single-height: every vertex goes to the new height;
  - otherwise: every vertex moves by the change, keeping their differences (floored at 0).
- `isValid()`: at least `minVertices` vertices.
- `onDrawClick(position)`: push the vertex (when clamped, stored at `height`, so unclamping
  later raises it there), clear the floating vertex, return "continue".
- `onDrawMove(position)`: set the floating vertex once there's at least one vertex; invalidate
  FILL | OUTLINE.
- `onDrawFinishRequest()`: drop the floating vertex and `finishDrawing()`.
- Draw hint, per state:
  - fewer than `minVertices`: "Drawing <type>: click to add vertices (at least <min>). Esc
    cancels."
  - otherwise: "Drawing <type>: <n> vertices. Click to add more; double-click or right-click to
    finish."
- Cursor message: "Click to add vertex", plus "\nDouble-click or right-click to finish" once
  there are enough vertices.
- Markers: `v<i>` (role vertex, index, deletable when deletable is on in EDIT and there are more
  than `minVertices` vertices, label i+1 when numbered), then `translateSpec()`, then
  `extraMarkerSpecs()` (default `[]`).
- A vertex drag moves only lon/lat and keeps the vertex's height.
- `onMarkerHeight`: a vertex of a multi-height shape sets that vertex's height (≥ 0); anything
  else calls `setHeight`. `markerHeight` matches that.
- `deleteMarker` removes the vertex.
- `vertexInsertAt(scene, windowPosition, tolerance = 8)`:
  1. For each edge (including the closing edge when `closed` and there are 3 or more vertices),
     sample 25 points between `edgeDisplayPosition(i)` and `edgeDisplayPosition(j)` along the arc
     type, and project them to the screen. A point behind the camera breaks the chain.
  2. For each screen segment, compute the distance from the cursor and the fraction along it.
  3. Accept a segment when the distance ≤ tolerance + `edgeReachPixels(edge, t, point)` (the
     larger of the segment's two ends); keep the nearest overall.
  4. Return `{ index: edge + 1, position: interpolate(stored a, stored b, t) }`, or undefined.

  Defaults: `edgeDisplayPosition(i)` is the drawn position of vertex i, and `edgeReachPixels()`
  returns 0.

**`Polyline`.** `type = "Polyline"`, `hasFill = false`, `insertOnDoubleClick = true`,
`minVertices = 2`. One open outline line through `drawPositions()`.

**`Polygon`.** `type = "Polygon"`, `insertOnDoubleClick = true`, `closed = true`,
`minVertices = 3`. Fill: `polygonGeometry(drawPositions())`. Outline: one line, looped once it
has 3 or more points.

Both call `Shape.register(...)` at the bottom of the file.

**Done when** a scratch page (or the Plan 02 demo) can draw a polygon with clicks and a
double-click, drag its vertices, delete one with the X, double-click an edge to insert one,
translate it, and shift+drag a vertex at altitude.

### Step 9: `Circle.js`
- `type = "Circle"`, `defaultMarkerOptions = { roleStyles: { radius: null } }` (plain squares).
- Fields: the base fields **without** `arcType` (a circle is defined by distance alone), plus
  `center` (position) and `radius` (distance, min 0).
- State: `center`, `radius = 0`. JSON: `{ center, radius }`.
- Setters `setCenter` and `setRadius` (min 0).
- Control point: the center. Valid when it has a center and radius > 0.
- Drawing:
  1. The first click sets the center and returns "continue".
  2. The second click sets `radius = distance(center, click)` and returns "done". Mouse moves
     update the radius.
  - Hints: "Drawing Circle: click to place the center." and then "Drawing Circle: click to set
    the radius. Esc cancels."
  - Cursor messages: "Click to set center" and "Click to set radius".
- Boundary:
  - `sampleArc(center, radius, 0, 2π, max(16, round(arcSegments / detailFactor)), GEODESIC, pointHeight)`
    with the repeated last point removed.
  - The fill is `polygonGeometry(boundary)`; the outline is one loop.
- **Flipping.**
  - `flipped` is true once the radius passes halfway to the antipode. Compare the summed chord
    distances from the four points at bearings 0/90/180/270 to the center and to the antipode.
  - `visualCenter()` is the center, or the antipode (at point height) when flipped.
  - `translateAnchor()` is the visual center.
- Markers:
  - The center goes at the visual center. In EDIT with `translatable` on, it *is* the
    translate marker; otherwise it's `{ key: "center", role: "center", flipped }`.
  - In EDIT, four radius markers `r0..r3` at bearings 0/90/180/270, with `axis` the outward
    arrival bearing.
- Dragging:
  - A radius marker sets the radius to the distance from the center.
  - A center marker sets the center, or the point opposite the dragged point when `flipped`.

### Step 10: `Rectangle.js`
- `type = "Rectangle"`. Fields: the base fields plus `cornerA` and `cornerB` (positions).
- State: two opposite corners. JSON: `{ cornerA, cornerB }`.
- Setters:
  - `setCorners(a, b)`.
  - `setCornerA` / `setCornerB`: the other corner defaults to the same point if it's missing.
- `bounds()` gives west/east/south/north in radians from the two corners (min/max).
- `corners()` gives NW, NE, SE, SW at point height.
- Valid when both spans are over 1e-9 rad.
- With RHUMB the edges run along parallels and meridians; with GEODESIC the same four corners
  are joined by geodesics. It doesn't cross the antimeridian.
- Drawing:
  - The first click sets both corners; moves and the second click set corner B.
  - Hints: "Drawing Rectangle: click the first corner." and then "Drawing Rectangle: click the
    opposite corner. Esc cancels."
  - Cursor messages: "Click to set first corner" and "Click to set opposite corner".
- The fill is `polygonGeometry(corners())`; the outline is a loop of the corners.
- `translateAnchor()`: the lon/lat midpoint of the bounds at point height.
- Markers:
  - While drawing: `c0` at corner A (role corner).
  - In EDIT: `c0..c3` on the corners (role corner, index), plus the translate marker.
- Dragging a corner keeps the opposite corner `(index + 2) % 4` and moves this one to the
  cursor.
- `translate(from, to)` shifts longitude and latitude instead of rotating, so the rectangle stays
  aligned with the grid. The latitude shift is clamped so the box stays within ±89.9°, and
  longitudes are wrapped.

### Step 11: `Sector.js`
- `type = "Sector"`, `defaultMarkerOptions = { roleStyles: { radius: null, start: null, end: null } }`.
- Fields: the base fields plus `center`, `radius` (min 0), `startBearing` and `endBearing`
  (angles, shown in [0, 360)).
- State: `center`, `radius`, and `startBearing` / `endBearing` in radians. JSON stores the
  bearings in degrees.
- The slice runs **clockwise** from start to end. `sweep` is `clockwiseSweep(start, end)`.
- Valid when it has a center, radius > 0 and sweep > 1e-6.
- Drawing (`_drawStep` 0..2):
  1. Click 0 sets the center.
  2. Click 1 sets the radius and start bearing (end = start), with moves previewing the radius
     line.
  3. Click 2 sets the end bearing and returns "done", with moves previewing the end.
  - Hints:
    - "Drawing Sector: click to place the center."
    - "Drawing Sector: click where the arc starts (sets the radius). Esc cancels."
    - "Drawing Sector: move clockwise and click where the arc ends. Esc cancels."
  - Cursor messages: "Click to set center", "Click to set radius and arc start" and "Click to set
    arc end".
- The arc has `max(4, ceil(arcSegments / detailFactor × sweep / 2π))` segments along the arc
  type. The boundary is the center followed by the arc, and the outline is one loop. Before it's
  valid (and while there's a radius), draw a line from the center to the start point.
- Markers:
  - Not EDIT: a `center` marker (role center).
  - In EDIT:
    - The translate marker at the center, or a plain center marker when `translatable` is off.
    - `start` and `end` on the arc ends.
    - `mid` (role `radius`, `shiftVertical: false`, `shiftRole: "rotate"`, `axis` outward) at
      the middle of the arc.
- Dragging:
  - **start / end:** set the radius and that bearing from the cursor. Shift+drag on these is the
    default height change.
  - **mid:** sets the radius. With shift it rotates instead: the middle of the arc follows the
    cursor's bearing, keeping the sweep and radius.
  - **center** (non-translate): moves the center.

### Step 12: `Box.js`
A rotatable box around a centerline. Also export
`BoxForm = Object.freeze({ ANCHORS: "anchors", CENTER: "center" })`.
- `type = "Box"`,
  `defaultMarkerOptions = { roleStyles: { width: { image: coloredMarkerImage(WIDTH_COLOR), width: 12, height: 12, align: false } } }`.
- **Stored geometry:** `center`, `length`, `width` (meters) and `heading` (radians, along the
  length). Both forms share this geometry; the form only changes how the box is drawn and which
  fields show.
- `anchors()`: the two ends, `destination(center, heading + π / heading, length/2)` at point
  height.
- Fields:
  - `form` (enum `["anchors", "center"]`).
  - ANCHORS form: `anchor1`, `anchor2` (positions).
  - CENTER form: `center`, `length` (min 0), `heading` (degrees in [0, 360)).
  - Both forms: `width` (min 0).
- Constructor options: `form`, `anchor1` + `anchor2` (these take precedence), `center`, `length`,
  `width` and `heading`.
- JSON: `{ form, center, length, width, heading° }`.
- Setting from anchors: the length is the distance, and when it's above 0 the center is the
  midpoint and the heading is the bearing from the center to anchor 2.
- `corners()`: offset each anchor ±90° from its local direction by width/2. The order is: left
  of anchor 1, left of anchor 2, right of anchor 2, right of anchor 1.
- The width from a point is `2 × |crossTrackDistance(point, a1, a2)|`.
- Valid when it has a center, length > 0 and width > 0.
- Fill: the corners polygon. Outline: the corner loop, or the centerline while drawing before the
  width is set.
- Setters:
  - `setForm` invalidates MARKERS only.
  - `setCenter`, `setLength`, `setWidth`, `setHeading`.
  - `setAnchors`, `setAnchor1` / `setAnchor2` (the other end stays put).
- Control points are the anchors. `translateAnchor()` is the center.
- `translate(from, to)` rotates the center and anchor 2 about the earth's center, then recomputes
  the heading, so the length stays exact.
- Drawing (`_drawStep` 0..2):
  1. Click 0 sets the first point (the center; also anchor 1 in ANCHORS form).
  2. Click 1 sets anchor 2 (ANCHORS), or the length (2 × distance) and heading (CENTER). Repeat
     "continue" while the length is 0.
  3. Click 2 sets the width from the cursor and returns "done" (repeat while the width is 0).
  - Moves preview the current step.
  - Cursor messages:
    - ANCHORS: "Click to set anchor 1", "Click to set anchor 2", "Click to set width".
    - CENTER: "Click to set center", "Click to set length and direction", "Click to set width".
  - Hints are "Drawing Box: <step>. Esc cancels.", with these steps:
    - ANCHORS: "click anchor 1 (one end of the box)", "click anchor 2 (the other end)", "move
      sideways and click to set the width".
    - CENTER: "click the center", "click to set the length and direction", "move sideways and
      click to set the width".
- Markers:
  - While drawing: plain `point` markers for the points placed so far.
  - In EDIT:
    - `anchor1`, `anchor2` (role `anchor`, index, numbered label, `shiftVertical: false`,
      `shiftRole: "end"`).
    - `side1`, `side2` (role `width`, at the center offset ±90° by width/2, with `axis` the
      outward arrival bearing), when the length is above 0.
    - The translate marker at the center.
- Dragging:
  - **An anchor:** moves that end; the other stays put.
  - **An anchor with shift:** rotates about the center. The center is fixed, the length becomes
    2 × the distance to the cursor, and the heading points the dragged end at the cursor.
  - **A width marker:** sets the width from the cursor.

### Step 13: `corridorGeometry.js`
Export `corridorLayout({ centers, radii, minAltitudes, maxAltitudes, arcType, altitudeMode, interactive })`.
It lays out a chain of cylinders: vertex i is a geodesic circle of radius rᵢ from altitude minᵢ
to maxᵢ, and each leg is the convex hull of two consecutive circles (tangent sides, so the width
tapers). It returns:

```js
{ footprintPolygons: [{ outer: Cartesian3[], holes: Cartesian3[][] }],  // at height 0
  footprintPoints(): Cartesian3[],
  volumeOutlines(): Cartesian3[][],           // open lines
  volumeGeometries(granularity): Geometry[] } // created geometries
```

How it works:
1. **Plane.** Work in a 2D plane where the arc type's lines are straight, so straight edges are
   exact.
   - GEODESIC: gnomonic projection, an `EllipsoidTangentPlane` through the centers.
   - RHUMB: ellipsoidal Mercator, with longitude relative to the first center (wrapped),
     latitude clamped to ±89.5°, and an iterative inverse.
2. **Circles.** Sample each circle with `sampleArc` along GEODESIC (64 samples, or 24 while
   interactive), project the points and take their convex hull.
3. **Legs.** Each leg's hull is the convex hull of two consecutive circle rings.
4. **Scale and step.** `scale` is the largest distance of any hull point from the plane's
   origin (at least 1). The ring densify step is max(scale / 96, 1), or scale / 48 while
   interactive. Points are only needed for the earth's curvature and for sloping heights.
5. **Footprint.** The union (`polygon-clipping`) of the leg hulls.
6. **Pieces.**
   - Circle i, minus circle i−1.
   - Leg i, minus circles i and i+1 and minus leg piece i−1.
   - Pieces are cut only against their neighbors along the chain, so a leg crossing a far leg
     at a different altitude stays a separate volume.
7. **Heights per piece at a plane point** `{ floor, ceil }`:
   - circle i: (minᵢ, maxᵢ);
   - leg i in `"step"` mode: (min of the two mins, max of the two maxes);
   - leg i in `"slope"` mode: interpolated by t = d0 / (d0 + d1), where d0 and d1 are the point's
     distances outside circle i and circle i+1 (0 inside).
8. **Edges.** For every densified edge of every piece ring, test a point just across the edge,
   offset by max(scale × 1e-5, tolerance × 10), for membership in a neighbor piece.
   - **No neighbor (an outside edge):** a full wall quad from floor to ceiling, with the edge
     added to the ceiling and floor outline polylines.
   - **A neighbor:** draw it once, from the piece with the higher id. Add a step-wall quad for the
     ceiling and/or the floor wherever the two pieces' heights differ by more than 0.5 m.
9. **Outputs.**
   - Footprint polygons: the rings densified and unprojected at height 0.
   - Volume geometries: for each piece polygon, a top and a bottom from `createPolygonGeometry`
     with `heightAt` returning that piece's ceiling or floor, plus one wall `Geometry` holding
     all the quads. Each quad has 2 triangles, a horizontal normal (or "up" for a zero-width
     quad) and st = (0,0)/(0,1)/(1,0)/(1,1).

Corridors must fit within a hemisphere around their centroid.

**Done when**, in Node, a 3-vertex layout with radii of 10 km returns one footprint polygon and
non-empty outlines and geometries, in both modes.

### Step 14: `Corridor.js`
`Corridor extends VertexShape`:
- Statics: `type = "Corridor"`, `minVertices = 2`, `singleHeight = true`,
  `insertOnDoubleClick = true`, `insertHint = "Double-click the corridor to add a vertex. "`.
- Also export `AltitudeMode = Object.freeze({ SLOPE: "slope", STEP: "step" })`.
- Role styles:
  - `radius`: `coloredMarkerImage(WIDTH_COLOR)`.
  - `altitude`: `coloredMarkerImage(ROTATE_COLOR)`.
  - Both 12×12, `align: false`, on top of `deletable: true`.
- Fields: the base fields minus `positions` and `height`, plus:
  - `vertices` (type table, min 2). Columns: lon (longitude), lat (latitude), radius (distance,
    min 1), minAltitude and maxAltitude (distance, min 0). Labels: "Lon °", "Lat °", "Radius m",
    "Min alt m", "Max alt m". `validate` throws "Vertex <n>: the max altitude must be at least
    the min altitude."
  - `altitudeMode` (enum, label "Between vertices").
- Options:
  - `vertices` (rows; takes precedence over `positions`).
  - `radius` (default 1000, at least 1). When neither `radius` nor the old `width` option is
    given, the radius is sized at the first draw click to about 40 px on screen:
    `round(40 × editor.metersPerPixelAt(click))`.
  - `minAltitude` (default 0) and `maxAltitude` (default 3000, at least min).
  - `altitudeMode` (default slope).
  - The old `width` option sets radius = width / 2.
- State: `positions` (on the ground, height 0) and the parallel arrays `radii`, `minAltitudes`,
  `maxAltitudes`. They're kept the same length as the positions: new entries copy the last
  value (or the defaults) and extra entries are dropped.
- JSON: `{ vertices: [{ lon, lat, radius, minAltitude, maxAltitude }], altitudeMode }`. Loading
  an old `{ positions, width }` file still works.
- `pointHeight` is always 0, and `setHeight` does nothing.
- Setters:
  - `getVertices` / `setVertices`.
  - `setVertexRadius(i, r ≥ 1)`.
  - `setVertexAltitudes(i, min ≥ 0, max ≥ min)`.
  - `setAltitudeMode`.
  - `scaleRadii(factor)`.
  - `scaleAltitudes(which, factor)` and `offsetAltitudes(which, delta)`, both keeping
    0 ≤ min ≤ max per vertex.
- Draw clicks store the vertex at height 0.
- `removeVertex` splices the arrays too.
- `insertVertex(i, p)`:
  - Between two vertices, take the leg's values at that point so the shape doesn't change:
    t = distance to the previous vertex ÷ (that + distance to the next).
    - The radius is interpolated by t.
    - SLOPE mode: the altitudes are interpolated by t.
    - STEP mode: the lower floor and the higher ceiling of the two vertices.
  - At either end, copy the nearest vertex.
- Layout: build `corridorLayout` once per rebuild from the drawn positions at height 0, with the
  arrays extended to the drawn count. Clear the cache in `invalidate`.
  - Fill:
    - clamped: one `polygonGeometry(outer, { holes, arcType: GEODESIC })` per footprint polygon
    - at altitude: `layout.volumeGeometries(polygonGranularity(footprintPoints, detail, detailFactor))`
    - set `_fillPositions` to the footprint points
  - Outline: the footprint rings as loops (clamped), or the volume outlines (altitude), all
    GEODESIC.
- Markers: for vertex i, the mid height is (minᵢ + maxᵢ)/2, or 0 when clamped.
  - `v<i>`: role vertex at the mid height (deletable / numbered as in VertexShape).
  - In EDIT, `r<i>`: role radius on the circle at bearing (direction − 90°), with `axis` and
    `shiftVertical: false`. The direction is the bearing along the path, averaged at interior
    vertices.
  - At altitude, `t<i>` / `b<i>` on the circle at bearing (direction + 90°), at the max / min
    altitude: role altitude, `which: "max" | "min"`, `vertical: true`, `axisUp: true`, with
    pixel offsets (0, −7) / (0, 7).
  - The translate marker last. Its anchor is the centroid at the average mid height.
- Dragging:
  - **A vertex** moves on the ground.
  - **A radius marker** sets that vertex's radius to the distance from the cursor. With shift,
    every radius is scaled by the factor that takes this one there.
- Heights (`onMarkerHeight`):
  - **Altitude marker:** sets that max or min (kept within limits).
  - **Altitude marker with shift:** moves *every* max (or min) by the dragged marker's change
    since the drag or the shift started. Compute it from a snapshot taken then, so values held
    at a limit recover when the drag reverses. Clear the snapshot on drag end and on a non-shift
    altitude drag.
  - **Vertex marker (shift):** raises that whole cylinder (min and max together).
  - **Translate marker (shift):** raises every cylinder.
  - Never move below the ground: limit the change by the lowest floor involved.
  - `markerHeight` returns the matching current value.
- Double-click insert:
  - `edgeDisplayPosition(i)` is vertex i at its mid height.
  - `edgeReachPixels(edge, t, point)` is
    `max(interpolated radius, interpolated half-height) / metersPerPixelAt(point)`. The
    half-height is 0 when clamped.

**Done when** a corridor can be drawn, shows its volume at altitude and its footprint when
clamped, and every marker behaves as described.

### Step 15: `ParallelLines.js`
- `type = "ParallelLines"`, `hasFill = false`. It uses the default marker looks, all white
  squares.
- Fields: the base fields plus:
  - `anchor1`, `anchor2` (positions, shown at point height).
  - `distance` (|offset|, min 0; setting it keeps the side).
  - `side` (enum `["right", "left"]`; setting it keeps the distance).
- State: `anchor1`, `anchor2`, and `offset` (signed meters, positive = right of
  anchor 1 → anchor 2). JSON: `{ anchor1, anchor2, offset }`.
- `length` is the distance between the anchors. `line1()` is both anchors at point height.
- `line2()`: line 1 densified into 64 pieces (at least 1 m each), then `offsetLine(…, offset)`.
  This keeps the gap constant, so on a long line it's a curve.
- The middle of line 1 is `interpolate(a1, a2, 0.5)`, with `along` = the bearing from it to a2.
  `line2Middle()` goes from there along `along + sign(offset) × 90°` for |offset|.
  `center()` is the same point at |offset|/2.
- The offset from a cursor point is **not** `crossTrackDistance`, which drifts on long rhumb
  lines. Instead:
  1. Extend line 1 past both ends along the arc type, by
     `min(2 × max(length, distance from a1, distance from a2), 5,000 km)`.
  2. On each of the three pieces (before, line 1, after), find the nearest point: 32 coarse
     samples, then a 40-step golden-section search around the best one.
  3. The offset is the distance from that foot to the cursor, signed by the side: the sine of
     (the bearing from the foot to the cursor − the direction of travel at the foot).
  Extending the line keeps drags past an end smooth.
- Valid when it has both anchors, length > 0 and offset ≠ 0.
- Outline: line 1 (key `"line1"`), plus line 2 (key `"line2"`) once it exists.
- Drawing (`_drawStep` 0..2):
  1. Click 0 sets both anchors.
  2. Click 1 sets anchor 2 (repeat while the length is 0), with moves previewing it.
  3. Click 2 sets the offset from the cursor and returns "done" (repeat while it's 0), with moves
     previewing it.
  - Cursor messages: "Click to set anchor 1", "Click to set anchor 2" and "Click to set the
    parallel line".
  - Hints are "Drawing Parallel lines: <step>. Esc cancels.", with the steps "click anchor 1 (one
    end of the first line)", "click anchor 2 (the other end)" and "move sideways and click to
    place the parallel line".
- Markers:
  - While drawing: plain `point` markers for the anchors placed so far.
  - In EDIT:
    - `anchor1` / `anchor2` (role anchor, index, numbered label).
    - `offset` at `line2Middle()` (role offset, `axis`, `shiftVertical: false`,
      `shiftRole: "rotate"`).
    - The translate marker at the middle of line 1.
- Dragging:
  - **An anchor** moves that end; the other stays put and the offset is kept.
  - **The offset marker** sets the offset from the cursor, which can flip line 2 to the other
    side.
  - **The offset marker with shift** rotates the shape about `center()`. Line 1's middle goes
    opposite the cursor at |offset|/2, line 1 runs perpendicular to that direction, and the
    length and offset are kept.
- Control points are the anchors (the default translate rotates them).

**Done when** this Node check passes for both arc types and both sides, on a line about 2000 km
long: line 2's cross-track distance stays within 1 m of the offset, the offset marker lies on
line 2, and dragging the offset marker to a point on line 2 reads the offset back to within
1 m.

### Step 16: `index.js`
The public entry point. Importing it registers every shape. Exports:
- `ShapeMode` and `ShapeEditor`.
- `Shape`, `Dirty`, `fieldPosition`, `fromDegrees`, `toDegrees` and `validateField`.
- `VertexShape`, `Polyline`, `Polygon`, `Corridor`, `Circle`, `Rectangle`, `Sector`, `Box`,
  `BoxForm` and `ParallelLines`.
- Everything from `materials.js`.
- `geodesy` (as a namespace).
- From `Markers.js`: `DEFAULT_MARKER_OPTIONS`, `DEFAULT_ROLE_STYLES`, `defaultMarkerImage`,
  `coloredMarkerImage`, `defaultDeleteImage`, `defaultTranslateImage`, `defaultResizeImage`,
  `defaultRotateImage` and `numberedPinImage`.

**Done when** `npx vite build` passes with the demo (Plan 02) importing from it.

## 6. Constants worth keeping exact

| Constant | Value | Where |
|---|---|---|
| Duplicate draw-click distance | 4 px | editor |
| Edge pick tolerance | 8 px | editor → `vertexInsertAt` |
| Double-click memory for a missed first click | 600 ms | editor |
| Edge samples for the insert pick | 24 per edge | VertexShape |
| Drill-pick limit | 6 | editor |
| Grown-ellipsoid buckets / cache limit | 10 cm / 64 | editor |
| Corridor auto radius | 40 px on screen | Corridor |
| Corridor circle samples | 64 (24 interactive) | corridorGeometry |
| Step wall threshold | 0.5 m | corridorGeometry |
| ParallelLines pieces / offset samples / golden steps / max extension | 64 / 32 / 40 / 5,000 km | ParallelLines |
| Marker default size, role icon size, X size, pin size | 12 / 22 / 18 / 36 px | Markers |

## 7. Verification checklist

**In Node.** Write scratch `.mjs` files next to the module they test; geometry needs no viewer.
- geodesy: the round trips in Step 2.
- liftedPolygon: the Step 3 check.
- corridorGeometry: the Step 13 check.
- ParallelLines: the Step 15 check.
- validateField: valid and invalid values for every type.
- JSON: for every shape type, `Shape.fromJSON(s.toJSON())` gives equal `getFields()`.

**In the browser** (with Plan 02):
- [ ] Every shape draws with the stated clicks, cursor messages and hints.
- [ ] Drawing works with both arc types, clamped and at altitude.
- [ ] Esc cancels drawing, then deselects.
- [ ] Every marker drags as described, with and without shift.
- [ ] Shift swaps the icon where `shiftRole` is set.
- [ ] Shift+drag changes the height at altitude, and does nothing extra when clamped.
- [ ] Translate works on every shape.
- [ ] Rectangle stays aligned with the grid when translated.
- [ ] Circle flips its center marker past the halfway radius.
- [ ] Deletable vertices show the X on hover or click; the X disappears at the minimum count.
- [ ] Double-click inserts on Polyline, Polygon (including the closing edge) and Corridor.
- [ ] Pattern materials show on clamped shapes and fall back to solid color at altitude.
- [ ] Fields read and write; invalid values throw readable messages.
- [ ] `shapeChanged` lists only the fields that changed.
- [ ] Nothing renders between interactions (`requestRenderMode`), yet the view stays up to
  date.

## 8. Pitfalls (each one was a real bug)

- Cesium polygon and corridor geometries flatten their input positions in place. Always pass
  clones.
- Cesium 1.122 `PolygonGeometry`:
  - per-position heights skip subdivision
  - large polygons duplicate triangles
  - polygons 180° or more wide throw
  - wide rhumb polygons hang
  Steps 3 and 6 work around all four.
- Cesium only fires the actions registered for the held modifier. Register every input action
  for SHIFT too, or nothing works while shift is held.
- A held key repeats `keydown`. Only restyle markers when shift actually changes.
- The click that ends a marker drag must not also select or deselect.
- `crossTrackDistance` is fine for edit handles on short lines but wrong on long rhumb lines;
  measure on the line itself when exactness matters (Step 15).
- Marker keys must stay stable across rebuilds, or a drag in progress loses its marker.
