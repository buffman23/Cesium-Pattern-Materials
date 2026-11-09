# Plan 02: Rebuild the `/shapes.html` demo

A step-by-step plan for the demo page that draws, edits and styles every shape type from the
shape library. **Plan 01 (`01-shape-library.md`) must be finished first.** The demo uses only
the library's public API (`src/shapes/index.js`), so it doubles as a reference app and a manual
test bench.

## How to use this plan

- Work through the steps in order. Each step ends with a **Done when** check.
- The prose is the specification. Code blocks appear only where an exact value matters (element
  ids, option values, the export format).
- Keep every element id and `<option>` value exactly as listed: the script looks them up by id,
  and the option values are the keys the material presets are built from.

## 1. What the page does

- **A toolbar (top left).** One button per shape type starts drawing it. Delete and Clear
  buttons. Controls that set the options for new shapes and also change the selected shape
  right away. A hint line and a "currently editing" line.
- **A field form (top right).** Built only from the selected (or currently drawn) shape's
  `fields`, with no code per shape type. It updates live as the shape changes, and editing it
  changes the shape.
- **Save and load from the devtools console:**
  - `shapesApp.exportState()` copies the shapes and camera as JSON.
  - `shapesApp.importState(json)` restores them.

## 2. Prerequisites (already in the repo; don't rebuild)

| File | What the demo uses |
|---|---|
| `vite.config.js` | A Vite config that copies Cesium's static folders (`ThirdParty`, `Workers`, `Assets`, `Widgets` from `node_modules/cesium/Build/Cesium`) to `/cesiumStatic` and defines `CESIUM_BASE_URL`. The main app (`index.html`) is already an entry. |
| `src/style.css` | Shared page styles: full-window `#cesiumContainer`, imports Cesium's `widgets.css`, the `#toolbar` panel (absolute, top-left, dark translucent, max width 360 px), toolbar buttons with an `.active` state, `#toolbar label`, `.row` (flex row of equal columns), `#hint`. |
| `src/shared/testPatterns.js` | `LINE_IMAGES` (keys `solid`, `dashed`, `wave`, `sawtooth`, `bottom` → URLs), `STAMP_IMAGES` (`x`, `arrow`), `POLYGON_IMAGES` (`hatch`, `dots`, `checkers`), `LINE_WIDTH` (24), `LINE_COLOR`, `STAMP_COLOR`, `HATCH_COLOR`, `HATCH_TILE_PIXELS` (48). |
| `public/patterns/*.svg` | The images those URLs point to. |
| `src/shapes/` | The library from Plan 01. |

## 3. Build steps

### Step 1: Vite entry
In `vite.config.js`:
- Add a second build input named `shapes` that points to `shapes.html` (next to the existing
  `main` input for `index.html`). Resolve both with `fileURLToPath(new URL(…, import.meta.url))`.
- Set `build.target` to `"es2022"`, because the demo script uses top-level `await`.

**Done when** `npm run dev` serves `/shapes.html` (still blank) and `npx vite build` emits a
`shapes` page.

### Step 2: `shapes.html`
A standard HTML5 page titled "Cesium Shapes". It links `/src/style.css`, then
`/src/shapesDemo.css`, and loads `/src/shapesDemo.js` as a module at the end of `body`.

The body contains, in this order:

1. `div#cesiumContainer`.
2. `div#toolbar`, containing:
   1. `div.buttons` with one button per shape, each with a `data-shape` attribute equal to the
      class name. Labels: Polyline, Polygon, Corridor, Circle, Rectangle, Sector, Box,
      "Parallel lines" (for `ParallelLines`).
   2. `div.buttons` with `button#btnDelete` ("Delete selected") and `button#btnClear` ("Clear").
   3. The rows of controls in the table below. Each control sits in its own `div` inside a
      `div.row`, with a `<label for=…>` above it.
   4. `div.checks` with six labeled checkboxes (second table).
   5. `div#hint` (initial text "Pick a shape to start drawing.") and an empty `div#selection`.
3. `div#fieldsPanel` (initially `hidden`), containing `div#fieldsTitle` and `div#fieldsBody`.

**Rows of controls:**

| Row | id | Label | Type | Values (default **bold**) |
|---|---|---|---|---|
| 1 | `arcType` | Arc type | select | **`GEODESIC`** "Geodesic", `RHUMB` "Rhumb" |
| 1 | `outlineWidth` | Outline width (px) | number 1–64 | **3** |
| 2 | `outlineMaterial` | Outline | select | **`color:white`** "White", `color:yellow` "Yellow", `pattern:solid`, `pattern:dashed`, `pattern:dashed+arrow` ("Pattern: dashed + arrows"), `pattern:wave` (each labeled "Pattern: …") |
| 2 | `fillMaterial` | Fill | select | **`color:white`** "White 25%", `color:cyan` "Cyan 35%", `pattern:hatch`, `pattern:dots`, `pattern:checkers`, `none` "None" |
| 3 | `height` | Height (m, altitude only) | number ≥ 0, step 100 | **5000** |
| 3 | `corridorAltitudeMode` | Corridor between vertices | select | **`slope`** "Slope", `step` "Step" |
| 4 | `corridorRadius` | Corridor radius (m) | number ≥ 1, step 100 | empty, placeholder "auto" |
| 4 | `corridorMinAltitude` | Min alt (m) | number ≥ 0, step 100 | **0** |
| 4 | `corridorMaxAltitude` | Max alt (m) | number ≥ 0, step 100 | **8000** |
| 5 | `boxForm` | Box defined by | select | **`anchors`** "Anchors + width", `center` "Center, length, width, heading" |

Put an HTML comment above row 4 saying that new corridor vertices start with these values and
that each vertex can then be changed on its own.

**Checkboxes** (`div.checks`, a two-column grid):

| id | Label | Default |
|---|---|---|
| `clampToGround` | Clamp to ground | off |
| `deletable` | Deletable vertices | **on** |
| `numbered` | Numbered markers | off |
| `translatable` | Translate marker | **on** |
| `groundLine` | Ground lines | off |
| `cursorMessages` | Cursor messages | **on** |

**Done when** the page shows the toolbar over an empty area (the globe comes in Step 4).

### Step 3: `src/shapesDemo.css`
Styles added on top of `style.css`. Use the same dark look throughout: panels
`rgba(42,42,42,0.85)` with a 6 px radius, inputs `#3a3a3a` with a `#666` border, text `#eee`,
labels `#bbb`, accent `#9fc4ff`.
- Toolbar selects and number inputs: full width, border-box, 4 px padding.
- `.checks`: a 2-column grid with small gaps; each label is a flex row with the checkbox.
- `#selection`: 12 px accent-colored text with a small top margin.
- `#fieldsPanel`:
  - Position: absolute, top 8 px, right 8 px, 340 px wide, max height `calc(100% - 40px)`,
    scrolls vertically.
  - Text: 12 px system font. `[hidden]` means `display: none`.
- `#fieldsTitle`: bold, accent-colored, with a bottom margin.
- `.field`: a bottom margin. Its label is a block in `#bbb`.
- Form inputs and selects: full width, compact, dark.
- `.triple` (lon / lat / height): a grid of `1.3fr 1.3fr 0.8fr`.
- `.vertex` (one row of a list): a grid of `16px 1.3fr 1.3fr 0.8fr 22px` (index, lon, lat,
  height, remove button). Table fields override the columns inline. The remove button is
  22 px tall, red text (`#ff6b6b`), grey when disabled.
- `.columns` (the header row): grey text. `.error`: `#ff8080`.
- Hide the number-input spinner buttons in the form (both `appearance: textfield` and the WebKit
  pseudo-elements), because they hide the digits of long coordinates.

**Done when** the toolbar looks finished. The form is checked in Step 8.

### Step 4: Viewer and editor (`src/shapesDemo.js`, part 1)
Import from `cesium`, from `./shapes/index.js` (every shape class, `Shape`, `ShapeEditor`,
`colorMaterial`, `patternLineMaterial` and `patternFillMaterial`), and from
`./shared/testPatterns.js`.

**Viewer.**
- Create it in `cesiumContainer`.
- Base layer: the offline Natural Earth II imagery, a `TileMapServiceImageryProvider` from
  `buildModuleUrl("Assets/Textures/NaturalEarthII")`, through `ImageryLayer.fromProviderAsync`.
- Turn off every widget: base layer picker, geocoder, home button, scene mode picker, navigation
  help, animation, timeline, fullscreen, info box and selection indicator.
- `requestRenderMode: true`, `maximumRenderTimeChange: Infinity`, `msaaSamples: 1` (MSAA tears
  ground polylines) and `scene3DOnly: true`.
- `globe.depthTestAgainstTerrain = false`.
- Start the camera over Denver: lon −104.99, lat 39.74, height 400 km.

Then define `SHAPES`, a map from class name (matching the `data-shape` values) to class, and
create the editor with `await ShapeEditor.create(viewer)`.

**Done when** the globe shows and the console has no errors.

### Step 5: Material presets
Build the material specs from the select values. **Each value maps to one shared spec**, cached
per kind ("outline" or "fill") and value. That way selecting the same preset for many shapes
reuses one spec, and changing one shape never affects another.

1. **Preload the images once.** Before building any pattern material, load and decode every
   image in `LINE_IMAGES`, `STAMP_IMAGES` and `POLYGON_IMAGES` (create an `Image`, set `src`,
   `await image.decode()`), in parallel, into three key → image maps. This uses top-level await.
   Then new shapes don't each wait for their own image.
2. **`materialFor(value, kind)`:**
   - `"none"` → undefined.
   - `color:<key>`: `colorMaterial` with these colors:
     - white is `WHITE` at 85 % alpha, except a *fill* white, which is 25 %
     - yellow is `#ffd400`
     - cyan is `#00e5ff` at 35 %
   - Outline `pattern:<line>[+<stamp>]`: `patternLineMaterial` with `lineImage` (the preloaded
     line image or null), `stampImage` (the preloaded stamp or null), `LINE_COLOR` and
     `STAMP_COLOR`, and `json: { type: "pattern", kind, value }`.
   - Fill `pattern:<key>`: `patternFillMaterial` with `image`, `color: HATCH_COLOR` and
     `tileSize: HATCH_TILE_PIXELS`, plus the same kind of `json`.
3. **`resolveMaterial(json)`**, used when loading: pattern JSON → `materialFor(json.value,
   json.kind)`. Color JSON is handled by the library.

**Done when** `materialFor("pattern:dashed+arrow", "outline")` returns the same object on a
second call.

### Step 6: Options for new shapes, and the toolbar buttons
`shapeOptions()` reads the controls into the options for `editor.startDrawing`:

| Option | From |
|---|---|
| `arcType` | `arcType` select → `ArcType.GEODESIC` / `RHUMB` |
| `clampToGround` | checkbox |
| `height` | number (blank → 0) |
| `outline` | `{ material: materialFor(outline, "outline"), width: number or 2 }` |
| `fill` | `{ material: materialFor(fill, "fill"), show: fill isn't "none" }` |
| `markers` | `{ deletable, numbered, translatable, groundLine }` from the checkboxes |
| `radius` | `corridorRadius` (blank → undefined, so the corridor sizes itself from the zoom) |
| `minAltitude` / `maxAltitude` | the corridor numbers (blank → 0) |
| `altitudeMode` | `corridorAltitudeMode` |
| `cursorMessages` | checkbox |
| `form` | `boxForm` |

Every shape gets every option; shape types ignore the ones that aren't theirs.

**Buttons.**
- A shape button calls `editor.startDrawing(SHAPES[button.dataset.shape], shapeOptions())`.
- Mark the button of the shape being drawn `.active` (compare `editor.drawing?.constructor.type`
  with each button's `data-shape`). Refresh this after each start and on every
  `editor.hint` event.
- `btnDelete` → `editor.selected?.remove()`; `btnClear` → `editor.clear()`.

**Editor events.**
- `editor.hint` → set `#hint` to the text, or "Pick a shape to start drawing." when the text is
  empty.
- `editor.selectionChanged` → set `#selection` to "Editing <type> (<id>)", or empty. When a shape
  is selected, copy its settings into the controls: arc type, outline width, clamp, height
  (rounded), the four marker checkboxes, cursor messages, plus the Box form (Box only) and the
  altitude mode (Corridor only).

**Done when** every shape type can be drawn from its button, and the hint follows each step.

### Step 7: Controls change the selected shape
Each control also applies to the selected shape (if any) as soon as it changes; with nothing
selected it only affects shapes drawn from now on.

| Control | Applies |
|---|---|
| `arcType` | `setArcType` |
| `outlineWidth` | `setOutlineWidth` (blank → 2) |
| `outlineMaterial` | `setOutlineMaterial` + `setOutlineWidth`, after the width rule below |
| `fillMaterial` | `setFillMaterial` (when there's a spec) and `setFillShow(spec exists)` |
| `height` | `setHeight` |
| `corridorAltitudeMode` | `setAltitudeMode`, Corridor only |
| `clampToGround` | Before unclamping a shape whose height is 0, `setHeight(height control)` first, so it doesn't sit on the ground. Then `setClampToGround`. |
| `boxForm` | `setForm`, Box only |
| `cursorMessages` | `setCursorMessages` |
| the four marker checkboxes | `setMarkerOptions({ deletable, numbered, translatable, groundLine })` |

**The outline width rule.** Pattern lines draw their images as tall as the line is wide, so
they're nearly invisible at 3 px.
- When the outline select switches from a color to a pattern and the width is below
  `LINE_WIDTH` (24), remember the width and set the width control to 24.
- When it switches back to a color and the width is still 24, restore the remembered width.
- Track whether the previous selection was a pattern, so only real switches trigger this.

The corridor radius and altitude inputs only affect new corridors. Existing ones are edited per
vertex in the form.

**Done when** changing any control while a shape is selected changes that shape immediately.

### Step 8: The field form
A panel on the right, built only from `shape.fields`, `getField` and `setField`, so it works
for every shape type (including future ones) with no per-type code.

**Which shape it shows:** `editor.drawing ?? editor.selected`. Rebuild the form (`showForm`)
on:
- `selectionChanged` and `shapeRemoved`;
- any `shapeChanged` where the target shape differs from the form's shape, or the target's list
  of field names differs from the form's rows (e.g. a Box switched form).

Otherwise, on `shapeChanged` for the form's shape, update the title and only the rows named in
`change.fields`.

**`showForm(shape)`.**
- Clear the body; hide the panel when there's no shape.
- Set the title to "<type> (<id>) — <mode>".
- Build one row per field, and fill each with `getField` (forced).

**A row**: a `div.field` with a label (with a unit suffix: " (m)" for distance, " (°)" for
angle), the editor for the field's type, and a `div.error`. Each row has an
`update(value, { force })` method. When not forced, **don't overwrite an input that has focus**,
so typing isn't interrupted by live updates.

| Field type | Editor |
|---|---|
| `boolean` | A checkbox placed inside the label. |
| `enum` | A select with the field's `options`. |
| `position` | `div.triple` with three number inputs (lon, lat at 6 decimals; height at 1 decimal). Any change sends the edited triple. |
| `positions` | A header row (`#`, `Lon °`, `Lat °`, `Height m`) and one `div.vertex` per position: index, three inputs, and a ✕ remove button (disabled at the field's `min` count). The label shows the count, "Vertices (5)". Rebuild the rows only when the count changes. An edit sends the whole list with one entry replaced; a remove sends it with one entry spliced out. |
| `table` | The same as `positions`, but with one column per `field.columns` entry (header from the column labels). The grid is set inline: `16px repeat(<columns>, minmax(0, 1fr)) 22px`. Lon/lat show 6 decimals; other columns 1. An edit replaces one cell of one row. |
| anything else (`distance`, `angle`, `number`) | One number input. Decimals: distance 1, angle 3, number 3. |

Number inputs use `step="any"` and apply on `change`. Show null as empty, and trim trailing
zeros (format with the fixed decimals, then convert back to a number).

**Applying a value.**
1. `setField(name, value)` in a try block.
2. On success, clear the row's error. On an exception, show its message in `.error`.
3. Either way, refresh the row from `getField`, forced. That reverts a rejected input, and shows
   a clamped value as the value actually applied.

**Done when**:
- The form follows drawing and selection.
- Dragging a marker updates only the affected rows live.
- Typing an invalid latitude (95) shows "… latitude must be between -90 and 90." and reverts.
- Removing vertices stops at the minimum.
- Switching the Box form rebuilds the form with the other fields.

### Step 9: Export and import
Expose `window.shapesApp = { viewer, editor, exportState, importState, SHAPES }` for the
console.

`exportState()` builds this JSON, copies it to the clipboard when possible, and returns the
string:

```js
{ camera: { lon, lat, height, heading, pitch, roll },  // degrees for lon/lat, radians for angles
  shapes: [ ...shape.toJSON() for every valid shape ] }
```
It logs "Shapes copied to the clipboard.", or "Couldn't access the clipboard; copy the returned
string instead."

`importState(json)` accepts the string or the object:
1. `editor.clear()`.
2. `editor.add(Shape.fromJSON(shape, { resolveMaterial }))` for each shape.
3. If a camera is present, `camera.setView` to it.
4. Request a render.

**Done when** exporting, reloading the page and importing restores every shape: positions,
pattern materials, clamp, height and corridor vertices, plus the camera.

## 4. Manual test script

Run this after the steps above; it also exercises the whole library.

1. **Polyline:** click 3 points, double-click to finish.
   - Drag a vertex.
   - Hover a vertex and click its red X.
   - Double-click a segment to insert a vertex.
   - Drag the move (four-arrow) marker.
2. **Polygon:** repeat the Polyline checks; also double-click the closing edge. Right-click while
   drawing with only 2 vertices: the shape is cancelled.
3. **Corridor:**
   - Draw it with the radius control blank; the first cylinder's radius is about 40 px on
     screen.
   - Turn off "Clamp to ground" and set the height: the volume shows, and the orange top and
     bottom squares appear.
   - Drag them, then shift+drag one: every max (or min) moves together.
   - Shift+drag a yellow radius square: every radius scales.
   - Switch slope/step. Double-click the corridor body: a vertex is added and the shape doesn't
     change.
4. **Circle:**
   - Draw it; drag the four radius squares.
   - Zoom out and drag the radius past half the globe: the center marker jumps to the antipode.
5. **Rectangle:** draw it; drag the corners and translate it. With Rhumb, the edges follow
   parallels; with Geodesic, the north and south edges bow.
6. **Sector:**
   - Draw the center, the start and the end (clockwise).
   - Drag start, end and middle; shift+drag the middle to rotate.
   - At altitude, shift+drag start or end to change the height.
7. **Box:**
   - Draw it in both forms.
   - Drag an end, then shift+drag an end (it shows the rotate icon and rotates about the
     center).
   - Drag the yellow width squares.
8. **Parallel lines:**
   - Draw anchor 1, anchor 2, then place line 2.
   - Drag the ends (the gap is kept).
   - Drag the middle marker across line 1 and past either end (smooth, no jump).
   - Shift+drag it (rotate icon; it rotates about the center).
9. **Styling:**
   - Pick "Pattern: dashed + arrows" with a clamped shape selected: the width jumps to 24 and the
     pattern shows. Pick White: the width goes back.
   - Pick a pattern fill. Unclamp the shape: it falls back to a solid color, with one console
     warning.
10. **Options:**
    - Numbered markers show pins.
    - Ground lines show at altitude.
    - Turning off the translate marker hides it.
    - Turning off cursor messages hides the box at the cursor.
11. **Keyboard:** Esc while drawing cancels; Esc while editing deselects.
12. **Persistence:** `shapesApp.exportState()`, reload the page, then `shapesApp.importState(<pasted>)`.
