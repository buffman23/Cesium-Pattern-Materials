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

const SHAPES = { Polyline, Polygon, Corridor, Circle, Rectangle, Sector };

// --- Materials, by select value (shared specs, so changing one shape doesn't affect others) --
const COLORS = {
  white: Color.WHITE.withAlpha(0.85),
  yellow: Color.fromCssColorString("#ffd400"),
  cyan: Color.fromCssColorString("#00e5ff").withAlpha(0.35),
};

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
        lineImage: LINE_IMAGES[line] ?? null,
        stampImage: STAMP_IMAGES[stamp] ?? null,
        lineColor: LINE_COLOR,
        stampColor: STAMP_COLOR,
      },
      { json: { type: "pattern", kind, value } },
    );
  } else {
    spec = patternFillMaterial(
      { image: POLYGON_IMAGES[key], color: HATCH_COLOR, tileSize: HATCH_TILE_PIXELS },
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
controls.outlineMaterial.addEventListener(
  "change",
  onSelected((s) => s.setOutlineMaterial(materialFor(controls.outlineMaterial.value, "outline"))),
);
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
for (const key of ["deletable", "numbered", "translatable", "groundLine"]) {
  controls[key].addEventListener("change", onSelected((s) => s.setMarkerOptions(markerOptions())));
}

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
