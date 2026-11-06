import {
  ArcType,
  Cartesian3,
  Math as CesiumMath,
  Color,
  ImageryLayer,
  TileMapServiceImageryProvider,
  Viewer,
  buildModuleUrl,
} from "cesium";
import {
  Circle,
  Corridor,
  Polygon,
  Polyline,
  Rectangle,
  Sector,
  Box,
  Shape,
  ShapeEditor,
  colorMaterial,
  patternFillMaterial,
  patternLineMaterial,
} from "./shapes/index.js";
import {
  HATCH_COLOR,
  HATCH_TILE_PIXELS,
  LINE_COLOR,
  LINE_IMAGES,
  LINE_WIDTH,
  POLYGON_IMAGES,
  STAMP_COLOR,
  STAMP_IMAGES,
} from "./shared/testPatterns.js";

// Demo of the Shape library (src/shapes): draw, edit and style every shape type.

const viewer = new Viewer("cesiumContainer", {
  baseLayer: ImageryLayer.fromProviderAsync(
    TileMapServiceImageryProvider.fromUrl(buildModuleUrl("Assets/Textures/NaturalEarthII")),
  ),
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
  requestRenderMode: true,
  maximumRenderTimeChange: Infinity,
  msaaSamples: 1, // see main.js: MSAA tears ground polylines
  scene3DOnly: true,
});
viewer.scene.globe.depthTestAgainstTerrain = false;
viewer.camera.setView({ destination: Cartesian3.fromDegrees(-104.99, 39.74, 400000) });

const SHAPES = { Polyline, Polygon, Corridor, Circle, Rectangle, Sector, Box };

// --- Materials, by select value (shared specs, so changing one shape doesn't affect others) --
const COLORS = {
  white: Color.WHITE.withAlpha(0.85),
  yellow: Color.fromCssColorString("#ffd400"),
  cyan: Color.fromCssColorString("#00e5ff").withAlpha(0.35),
};

// Load and decode the pattern images once (like renderer.js), so every pattern material shares
// them and new shapes don't each wait for their own image load.
async function loadImages(urls) {
  const entries = await Promise.all(
    Object.entries(urls).map(async ([key, url]) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      return [key, image];
    }),
  );
  return Object.fromEntries(entries);
}
const [lineImages, stampImages, polygonImages] = await Promise.all([
  loadImages(LINE_IMAGES),
  loadImages(STAMP_IMAGES),
  loadImages(POLYGON_IMAGES),
]);

const isPatternLine = (value) => value.startsWith("pattern:");

const specs = new Map();
function materialFor(value, kind) {
  if (value === "none") {
    return undefined;
  }
  const cacheKey = `${kind}|${value}`;
  if (specs.has(cacheKey)) {
    return specs.get(cacheKey);
  }
  const [type, key] = value.split(":");
  let spec;
  if (type === "color") {
    const color = kind === "fill" && key === "white" ? Color.WHITE.withAlpha(0.25) : COLORS[key];
    spec = colorMaterial(color);
  } else if (kind === "outline") {
    const [line, stamp] = key.split("+");
    spec = patternLineMaterial(
      {
        lineImage: lineImages[line] ?? null,
        stampImage: stampImages[stamp] ?? null,
        lineColor: LINE_COLOR,
        stampColor: STAMP_COLOR,
      },
      { json: { type: "pattern", kind, value } },
    );
  } else {
    spec = patternFillMaterial(
      { image: polygonImages[key], color: HATCH_COLOR, tileSize: HATCH_TILE_PIXELS },
      { json: { type: "pattern", kind, value } },
    );
  }
  specs.set(cacheKey, spec);
  return spec;
}

const resolveMaterial = (json) =>
  json.type === "pattern" ? materialFor(json.value, json.kind) : undefined;

// --- Controls ------------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const controls = {
  arcType: $("arcType"),
  outlineWidth: $("outlineWidth"),
  outlineMaterial: $("outlineMaterial"),
  fillMaterial: $("fillMaterial"),
  height: $("height"),
  corridorWidth: $("corridorWidth"),
  clampToGround: $("clampToGround"),
  deletable: $("deletable"),
  numbered: $("numbered"),
  translatable: $("translatable"),
  groundLine: $("groundLine"),
  cursorMessages: $("cursorMessages"),
  boxForm: $("boxForm"),
};

const arcType = () => (controls.arcType.value === "RHUMB" ? ArcType.RHUMB : ArcType.GEODESIC);
const markerOptions = () => ({
  deletable: controls.deletable.checked,
  numbered: controls.numbered.checked,
  translatable: controls.translatable.checked,
  groundLine: controls.groundLine.checked,
});
const fillValue = () => controls.fillMaterial.value;

function shapeOptions() {
  const fill = materialFor(fillValue(), "fill");
  return {
    arcType: arcType(),
    clampToGround: controls.clampToGround.checked,
    height: Number(controls.height.value) || 0,
    outline: {
      material: materialFor(controls.outlineMaterial.value, "outline"),
      width: Number(controls.outlineWidth.value) || 2,
    },
    fill: { material: fill, show: Boolean(fill) },
    // "deletable" only affects shapes with vertex markers (Polyline, Polygon, Corridor).
    markers: markerOptions(),
    width: Number(controls.corridorWidth.value) || 1000,
    cursorMessages: controls.cursorMessages.checked,
    form: controls.boxForm.value, // Box only
  };
}

// --- Editor --------------------------------------------------------------------------------
const editor = await ShapeEditor.create(viewer);
const hint = $("hint");
const selection = $("selection");
const shapeButtons = [...document.querySelectorAll("[data-shape]")];

function updateButtons() {
  const type = editor.drawing?.constructor.type;
  for (const button of shapeButtons) {
    button.classList.toggle("active", button.dataset.shape === type);
  }
}

editor.hint.addEventListener((text) => {
  hint.textContent = text || "Pick a shape to start drawing.";
  updateButtons();
});

editor.selectionChanged.addEventListener((shape) => {
  selection.textContent = shape ? `Editing ${shape.constructor.type} (${shape.id})` : "";
  if (!shape) {
    return;
  }
  // Show the selected shape's settings in the controls.
  controls.arcType.value = shape.arcType === ArcType.RHUMB ? "RHUMB" : "GEODESIC";
  controls.outlineWidth.value = String(shape.outline.width);
  controls.clampToGround.checked = shape.clampToGround;
  controls.height.value = String(Math.round(shape.height));
  controls.deletable.checked = shape.markerOptions.deletable;
  controls.numbered.checked = shape.markerOptions.numbered;
  controls.translatable.checked = shape.markerOptions.translatable;
  controls.groundLine.checked = shape.markerOptions.groundLine;
  controls.cursorMessages.checked = shape.cursorMessages !== false;
  if (shape instanceof Box) {
    controls.boxForm.value = shape.form;
  }
  if (shape instanceof Corridor) {
    controls.corridorWidth.value = String(Math.round(shape.width));
  }
});

for (const button of shapeButtons) {
  button.addEventListener("click", () => {
    editor.startDrawing(SHAPES[button.dataset.shape], shapeOptions());
    updateButtons();
  });
}

$("btnDelete").addEventListener("click", () => editor.selected?.remove());
$("btnClear").addEventListener("click", () => editor.clear());

// Each control applies to the selected shape (and to shapes drawn from now on).
const onSelected = (apply) => () => {
  const shape = editor.selected;
  if (shape) {
    apply(shape);
  }
};
controls.arcType.addEventListener("change", onSelected((s) => s.setArcType(arcType())));
controls.outlineWidth.addEventListener(
  "change",
  onSelected((s) => s.setOutlineWidth(Number(controls.outlineWidth.value) || 2)),
);
// Pattern lines draw their images as tall as the line is wide, so they need a wide line (the
// main demo uses LINE_WIDTH, 24 px); at a color outline's 3 px they're barely visible. Picking
// a pattern widens a narrower outline to LINE_WIDTH; going back to a color restores the width.
let colorOutlineWidth = Number(controls.outlineWidth.value) || 3;
let patternSelected = isPatternLine(controls.outlineMaterial.value);
controls.outlineMaterial.addEventListener("change", () => {
  const pattern = isPatternLine(controls.outlineMaterial.value);
  const width = Number(controls.outlineWidth.value) || 2;
  if (pattern && !patternSelected && width < LINE_WIDTH) {
    colorOutlineWidth = width;
    controls.outlineWidth.value = String(LINE_WIDTH);
  } else if (!pattern && patternSelected && width === LINE_WIDTH) {
    controls.outlineWidth.value = String(colorOutlineWidth);
  }
  patternSelected = pattern;
  const shape = editor.selected;
  if (shape) {
    shape.setOutlineMaterial(materialFor(controls.outlineMaterial.value, "outline"));
    shape.setOutlineWidth(Number(controls.outlineWidth.value) || 2);
  }
});
controls.fillMaterial.addEventListener(
  "change",
  onSelected((s) => {
    const fill = materialFor(fillValue(), "fill");
    if (fill) {
      s.setFillMaterial(fill);
    }
    s.setFillShow(Boolean(fill));
  }),
);
controls.height.addEventListener(
  "change",
  onSelected((s) => s.setHeight(Number(controls.height.value) || 0)),
);
controls.corridorWidth.addEventListener(
  "change",
  onSelected((s) => s instanceof Corridor && s.setWidth(Number(controls.corridorWidth.value) || 1000)),
);
controls.clampToGround.addEventListener(
  "change",
  onSelected((s) => {
    if (!controls.clampToGround.checked && s.height === 0) {
      s.setHeight(Number(controls.height.value) || 0);
    }
    s.setClampToGround(controls.clampToGround.checked);
  }),
);
controls.boxForm.addEventListener(
  "change",
  onSelected((s) => s instanceof Box && s.setForm(controls.boxForm.value)),
);
controls.cursorMessages.addEventListener(
  "change",
  onSelected((s) => s.setCursorMessages(controls.cursorMessages.checked)),
);
for (const key of ["deletable", "numbered", "translatable", "groundLine"]) {
  controls[key].addEventListener("change", onSelected((s) => s.setMarkerOptions(markerOptions())));
}

// --- Selected shape form -------------------------------------------------------------------
// Built only from shape.fields / getField / setField, so it works for every shape type
// (custom subclasses included) without knowing any of them. It follows the shape being drawn,
// or else the selected one, and refreshes from editor.shapeChanged.
const fieldsPanel = $("fieldsPanel");
const fieldsTitle = $("fieldsTitle");
const fieldsBody = $("fieldsBody");
let formShape;
const formRows = new Map(); // field name -> { field, update(value) }

const UNITS = { distance: "m", angle: "°" };
const DECIMALS = { distance: 1, angle: 3, number: 3 };
const showNumber = (value, decimals) => (value === null || value === undefined ? "" : String(+value.toFixed(decimals)));

function numberInput(onChange) {
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.addEventListener("change", onChange);
  return input;
}

// Sets a field from the form; on a bad value shows the message and reverts the inputs.
function apply(row, value) {
  try {
    formShape.setField(row.field.name, value);
    row.error.textContent = "";
  } catch (error) {
    row.error.textContent = error.message;
  }
  row.update(formShape.getField(row.field.name), { force: true });
}

const focusedIn = (element) => element.contains(document.activeElement);

// [lon, lat, height] editor: three inputs; `onChange` gets the edited triple.
function positionInputs(container, onChange) {
  const inputs = [0, 1, 2].map(() => numberInput(() => onChange(inputs.map((i) => i.value))));
  container.append(...inputs);
  return (value) => {
    inputs.forEach((input, i) => {
      input.value = value ? showNumber(value[i], i < 2 ? 6 : 1) : "";
    });
  };
}

function fieldRow(field) {
  const element = document.createElement("div");
  element.className = "field";
  const label = document.createElement("label");
  label.textContent = UNITS[field.type] ? `${field.label} (${UNITS[field.type]})` : field.label;
  const error = document.createElement("div");
  error.className = "error";
  const row = { field, element, error, update: () => {} };

  if (field.type === "boolean") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.addEventListener("change", () => apply(row, input.checked));
    label.prepend(input, " ");
    element.append(label);
    row.update = (value) => {
      input.checked = Boolean(value);
    };
  } else if (field.type === "enum") {
    const select = document.createElement("select");
    for (const option of field.options) {
      select.append(new Option(option, option));
    }
    select.addEventListener("change", () => apply(row, select.value));
    element.append(label, select);
    row.update = (value) => {
      select.value = value ?? "";
    };
  } else if (field.type === "position") {
    const triple = document.createElement("div");
    triple.className = "triple";
    const set = positionInputs(triple, (value) => apply(row, value));
    element.append(label, triple);
    row.update = (value, { force } = {}) => {
      if (force || !focusedIn(triple)) {
        set(value);
      }
    };
  } else if (field.type === "positions") {
    const list = document.createElement("div");
    const header = document.createElement("div");
    header.className = "vertex columns";
    header.innerHTML = "<span>#</span><span>Lon °</span><span>Lat °</span><span>Height m</span><span></span>";
    element.append(label, header, list);
    let setters = [];
    row.update = (value, { force } = {}) => {
      const positions = value ?? [];
      label.textContent = `${field.label} (${positions.length})`;
      if (setters.length !== positions.length) {
        // Vertex count changed: rebuild the rows.
        list.replaceChildren();
        setters = positions.map((_, index) => {
          const vertex = document.createElement("div");
          vertex.className = "vertex";
          const number = document.createElement("span");
          number.textContent = index + 1;
          vertex.append(number);
          const set = positionInputs(vertex, (edited) => {
            const next = formShape.getField(field.name);
            next[index] = edited;
            apply(row, next);
          });
          const remove = document.createElement("button");
          remove.textContent = "✕";
          remove.title = "Remove vertex";
          remove.disabled = positions.length <= (field.min ?? 0);
          remove.addEventListener("click", () => {
            const next = formShape.getField(field.name);
            next.splice(index, 1);
            apply(row, next);
          });
          vertex.append(remove);
          list.append(vertex);
          return { vertex, set };
        });
      }
      positions.forEach((position, index) => {
        const { vertex, set } = setters[index];
        if (force || !focusedIn(vertex)) {
          set(position);
        }
      });
    };
  } else {
    const input = numberInput(() => apply(row, input.value));
    element.append(label, input);
    const decimals = DECIMALS[field.type] ?? 3;
    row.update = (value, { force } = {}) => {
      if (force || document.activeElement !== input) {
        input.value = showNumber(value, decimals);
      }
    };
  }
  element.append(error);
  return row;
}

function showForm(shape) {
  formShape = shape;
  formRows.clear();
  fieldsBody.replaceChildren();
  fieldsPanel.hidden = !shape;
  if (!shape) {
    return;
  }
  fieldsTitle.textContent = `${shape.constructor.type} (${shape.id}) — ${shape.mode}`;
  for (const field of shape.fields) {
    const row = fieldRow(field);
    formRows.set(field.name, row);
    fieldsBody.append(row.element);
    row.update(shape.getField(field.name), { force: true });
  }
}

const formTarget = () => editor.drawing ?? editor.selected;
editor.selectionChanged.addEventListener(() => showForm(formTarget()));
editor.shapeRemoved.addEventListener(() => showForm(formTarget()));
editor.shapeChanged.addEventListener((shape, change) => {
  const target = formTarget();
  // A different shape (e.g. drawing just started), or the same shape with a different set of
  // fields (e.g. a Box switched form): rebuild the form.
  const names = target?.fields.map((f) => f.name).join() ?? "";
  if (target !== formShape || names !== [...formRows.keys()].join()) {
    showForm(target);
    return;
  }
  if (shape !== formShape) {
    return;
  }
  fieldsTitle.textContent = `${shape.constructor.type} (${shape.id}) — ${shape.mode}`;
  for (const name of change.fields) {
    formRows.get(name)?.update(shape.getField(name));
  }
});

// --- Export / import -----------------------------------------------------------------------
// In the devtools console: `shapesApp.exportState()` copies the shapes and camera as JSON;
// `shapesApp.importState(json)` recreates them.
function exportState() {
  const camera = viewer.camera;
  const c = camera.positionCartographic;
  const state = {
    camera: {
      lon: CesiumMath.toDegrees(c.longitude),
      lat: CesiumMath.toDegrees(c.latitude),
      height: c.height,
      heading: camera.heading,
      pitch: camera.pitch,
      roll: camera.roll,
    },
    shapes: editor.shapes.filter((s) => s.isValid()).map((s) => s.toJSON()),
  };
  const json = JSON.stringify(state);
  navigator.clipboard?.writeText(json).then(
    () => console.log("Shapes copied to the clipboard."),
    () => console.log("Couldn't access the clipboard; copy the returned string instead."),
  );
  return json;
}

function importState(json) {
  const state = typeof json === "string" ? JSON.parse(json) : json;
  editor.clear();
  for (const shapeJson of state.shapes ?? []) {
    editor.add(Shape.fromJSON(shapeJson, { resolveMaterial }));
  }
  if (state.camera) {
    const c = state.camera;
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(c.lon, c.lat, c.height),
      orientation: { heading: c.heading, pitch: c.pitch, roll: c.roll },
    });
  }
  viewer.scene.requestRender();
}

window.shapesApp = { viewer, editor, exportState, importState, SHAPES };
