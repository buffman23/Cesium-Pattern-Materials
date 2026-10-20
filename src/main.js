import {
  Cartesian3,
  Cartographic,
  ImageryLayer,
  Math as CesiumMath,
  TileMapServiceImageryProvider,
  Viewer,
  buildModuleUrl,
} from "cesium";
import DrawTool, { MIN_POINTS } from "./tools/DrawTool.js";
import solutions from "./solutions/index.js";
import { LINE_WIDTH, STAMP_SPACING } from "./shared/testPatterns.js";

// --- Viewer (offline imagery, no Ion token needed) -----------------------------------------
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
  // Render only when something changes, instead of every animation frame. Camera moves and
  // tile loads request frames themselves; changes made by this app call requestRender().
  requestRenderMode: true,
  maximumRenderTimeChange: Infinity,
  // No MSAA: with it, ground-clamped lines (GroundPolylinePrimitive) lose scattered pixels to
  // Cesium's depth-based tests at large distances and look torn, even with a plain color
  // material. The patterns are smoothed by their own texture filtering anyway.
  msaaSamples: 1,
  // 3D only: primitives then skip building 2D / Columbus-view geometry, which roughly halves
  // the cost of rebuilding shapes while editing.
  scene3DOnly: true,
});
viewer.scene.globe.depthTestAgainstTerrain = false;
const requestRender = () => viewer.scene.requestRender();
viewer.camera.setView({
  destination: Cartesian3.fromDegrees(-104.99, 39.74, 15000),
});

// --- Solution (rendering implementation; there is one, so no picker) --------------------------
const description = document.getElementById("solutionDescription");

let renderer; // undefined while a renderer is being created
let solutionId;
let switchId = 0;

async function useSolution(id) {
  const solution = solutions.find((s) => s.id === id) ?? solutions[0];
  solutionId = solution.id;
  description.textContent = solution.description;

  const thisSwitch = ++switchId;
  renderer?.destroy();
  renderer = undefined;
  const created = await solution.createRenderer(viewer);
  if (thisSwitch !== switchId) {
    created.destroy(); // superseded by a newer selection
    return;
  }
  renderer = created;
  renderer.setLineWidth?.(lineWidth);
  renderer.setStampSpacing?.(stampSpacing);
  renderer.setImages?.({ line: lineImage, stamp: stampImage });
  // Re-render the existing shapes with the newly selected solution.
  for (const shape of drawTool.shapes) {
    if (shape.positions.length >= MIN_POINTS[shape.type]) {
      renderer.update(shape);
    }
  }
  requestRender();
}

// --- Draw tool + toolbar -------------------------------------------------------------------
const hint = document.getElementById("hint");
const buttons = {
  polyline: document.getElementById("btnPolyline"),
  polygon: document.getElementById("btnPolygon"),
};

const drawTool = new DrawTool(viewer, {
  onChange: (shape) => {
    renderer?.update(shape);
    requestRender();
  },
  onRemove: (shape) => {
    renderer?.remove(shape);
    requestRender();
  },
  onHint: (text) => {
    hint.textContent = text;
    const activeType = drawTool?.active?.type;
    for (const [type, button] of Object.entries(buttons)) {
      button.classList.toggle("active", type === activeType);
    }
  },
});

buttons.polyline.addEventListener("click", () => drawTool.start("polyline"));
buttons.polygon.addEventListener("click", () => drawTool.start("polygon"));
document.getElementById("btnClear").addEventListener("click", () => drawTool.clear());

// --- Line width slider ---------------------------------------------------------------------
const lineWidthInput = document.getElementById("lineWidth");
const lineWidthValue = document.getElementById("lineWidthValue");
let lineWidth = LINE_WIDTH;
lineWidthInput.value = String(lineWidth);
lineWidthValue.textContent = `${lineWidth} px`;
lineWidthInput.addEventListener("input", () => {
  lineWidth = Number(lineWidthInput.value);
  lineWidthValue.textContent = `${lineWidth} px`;
  renderer?.setLineWidth?.(lineWidth);
  requestRender();
});

// --- Stamp spacing slider ------------------------------------------------------------------
const stampSpacingInput = document.getElementById("stampSpacing");
const stampSpacingValue = document.getElementById("stampSpacingValue");
let stampSpacing = STAMP_SPACING;

// The slider is logarithmic (value v -> 2^v), so 1x sits in the middle of 0.25x..4x.
function setStampSpacing(value) {
  stampSpacing = value;
  stampSpacingInput.value = String(Math.log2(value));
  stampSpacingValue.textContent = `${value.toFixed(2)}×`;
  renderer?.setStampSpacing?.(value);
  requestRender();
}

setStampSpacing(stampSpacing);
stampSpacingInput.addEventListener("input", () =>
  setStampSpacing(2 ** Number(stampSpacingInput.value)),
);

// --- Line / stamp image comboboxes ("" = none) ----------------------------------------------
const lineImageSelect = document.getElementById("lineImage");
const stampImageSelect = document.getElementById("stampImage");
let lineImage = lineImageSelect.value || null;
let stampImage = stampImageSelect.value || null;

function setImages({ line = lineImage, stamp = stampImage } = {}) {
  lineImage = line;
  stampImage = stamp;
  lineImageSelect.value = line ?? "";
  stampImageSelect.value = stamp ?? "";
  renderer?.setImages?.({ line, stamp });
  requestRender();
}

lineImageSelect.addEventListener("change", () => setImages({ line: lineImageSelect.value || null }));
stampImageSelect.addEventListener("change", () =>
  setImages({ stamp: stampImageSelect.value || null }),
);

useSolution();

// --- Camera height readout ----------------------------------------------------------------
const cameraHeight = document.getElementById("cameraHeight");

function formatHeight(meters) {
  if (meters < 10) {
    return `${meters.toFixed(2)} m`;
  }
  if (meters < 1000) {
    return `${meters.toFixed(1)} m`;
  }
  const km = (meters / 1000).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${km} km`;
}

// postRender fires every frame; only touch the DOM when the text changes.
viewer.scene.postRender.addEventListener(() => {
  const text = `Camera height: ${formatHeight(viewer.camera.positionCartographic.height)}`;
  if (cameraHeight.textContent !== text) {
    cameraHeight.textContent = text;
  }
});

// --- Scene export / import (for sharing an exact view) -------------------------------------
// In the devtools console: `app.exportState()` copies the shapes, camera, line width, stamp
// spacing and shader to the clipboard as JSON; `app.importState(json)` recreates that scene.

function exportState() {
  const camera = viewer.camera;
  const position = camera.positionCartographic;
  const state = {
    solution: solutionId,
    lineWidth,
    stampSpacing,
    lineImage,
    stampImage,
    canvas: [viewer.canvas.clientWidth, viewer.canvas.clientHeight],
    camera: {
      lon: CesiumMath.toDegrees(position.longitude),
      lat: CesiumMath.toDegrees(position.latitude),
      height: position.height,
      heading: camera.heading,
      pitch: camera.pitch,
      roll: camera.roll,
    },
    shapes: drawTool.shapes
      .filter((shape) => shape.complete)
      .map((shape) => ({
        type: shape.type,
        positions: shape.positions.map((p) => {
          const c = Cartographic.fromCartesian(p);
          return [CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude)];
        }),
      })),
  };
  const json = JSON.stringify(state);
  navigator.clipboard?.writeText(json).then(
    () => console.log("Scene copied to the clipboard."),
    () => console.log("Couldn't access the clipboard; copy the returned string instead."),
  );
  return json;
}

async function importState(json) {
  const state = typeof json === "string" ? JSON.parse(json) : json;
  if (state.solution && state.solution !== solutionId) {
    await useSolution(state.solution);
  }
  if (state.lineWidth) {
    lineWidth = state.lineWidth;
    lineWidthInput.value = String(lineWidth);
    lineWidthValue.textContent = `${lineWidth} px`;
    renderer?.setLineWidth?.(lineWidth);
  }
  if (state.stampSpacing) {
    setStampSpacing(state.stampSpacing);
  }
  if (state.lineImage !== undefined || state.stampImage !== undefined) {
    setImages({ line: state.lineImage, stamp: state.stampImage });
  }
  drawTool.clear();
  for (const shape of state.shapes ?? []) {
    drawTool.addShape(
      shape.type,
      shape.positions.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat)),
    );
  }
  if (state.camera) {
    const c = state.camera;
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(c.lon, c.lat, c.height),
      orientation: { heading: c.heading, pitch: c.pitch, roll: c.roll },
    });
  }
  requestRender();
  const [width, height] = state.canvas ?? [];
  if (width && (width !== viewer.canvas.clientWidth || height !== viewer.canvas.clientHeight)) {
    console.log(
      `Note: the scene was exported from a ${width}x${height} view; this one is ` +
        `${viewer.canvas.clientWidth}x${viewer.canvas.clientHeight}, so framing will differ slightly.`,
    );
  }
}

// Handy for poking at things from the devtools console.
window.app = {
  viewer,
  drawTool,
  useSolution,
  exportState,
  importState,
  get renderer() {
    return renderer;
  },
};
