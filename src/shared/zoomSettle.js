import { Cartesian2, Cartesian3 } from "cesium";

// Patterns pick a power-of-two scale from the zoom level, log2(pattern meters), and cross-fade
// between two scales while the level's fractional part is inside a "fade window". Anything that
// depends on the camera height alone stays half faded if the camera stops inside that window.
// So once the height has stopped changing, each layer gets a small level shift (applied to every
// pixel alike, so the fade gradient just moves and no seam appears), animated so that the screen
// centre leaves the window by its nearest edge. While the height changes the shift stays put, so
// fades follow the zoom smoothly.

const REST_DELAY_MS = 150; // no height change for this long = at rest
const SPEED = 0.3; // levels per second
const MARGIN = 0.03; // levels beyond the window edge, so nearby pixels are out of it too

const scratchCenter = new Cartesian2();
const scratchOffset = new Cartesian3();
const scratchPixel = new Cartesian2();
const reference = { scene: undefined, frame: -1, metersPerPixel: 1 };

/**
 * Meters per CSS pixel on the ground at the screen centre (or below the camera when the centre
 * shows sky), measured like the shaders' czm_metersPerPixel. Computed once per frame.
 *
 * @param {Scene} scene
 * @returns {number}
 */
export function referenceMetersPerPixel(scene) {
  const frame = scene.frameState.frameNumber;
  if (reference.scene === scene && reference.frame === frame) {
    return reference.metersPerPixel;
  }
  const camera = scene.camera;
  const canvas = scene.canvas;
  Cartesian2.fromElements(canvas.clientWidth / 2, canvas.clientHeight / 2, scratchCenter);
  const ground = camera.pickEllipsoid(scratchCenter, scene.globe?.ellipsoid);
  const depth = ground
    ? Cartesian3.dot(Cartesian3.subtract(ground, camera.positionWC, scratchOffset), camera.directionWC)
    : camera.positionCartographic.height;
  const pixel = camera.frustum.getPixelDimensions(
    scene.drawingBufferWidth,
    scene.drawingBufferHeight,
    Math.max(depth, 1e-3),
    scene.pixelRatio,
    scratchPixel,
  );
  reference.scene = scene;
  reference.frame = frame;
  reference.metersPerPixel = Math.max(pixel.y, 1e-9);
  return reference.metersPerPixel;
}

/** @returns {object} Per-material settle state for {@link updateZoomSettle}. */
export function createZoomSettle() {
  return { height: undefined, lastChange: -Infinity, lastFrame: undefined, shifts: {} };
}

/**
 * Advances the level shifts one frame and requests another frame while they are still moving.
 *
 * @param {object} state From {@link createZoomSettle}.
 * @param {Scene} scene
 * @param {Object<string, {level: number, window: number[]}>} layers Per layer: the zoom level at
 *   the screen centre, log2(pattern meters), and the [start, end] range of its fractional part
 *   where the layer is partly faded (end may exceed 1).
 * @returns {Object<string, number>} Per layer, the shift to add to the level in the shader.
 */
export function updateZoomSettle(state, scene, layers) {
  const now = performance.now();
  const height = scene.camera.positionCartographic.height;
  if (state.height !== undefined && Math.abs(height - state.height) > 1e-6 * Math.abs(height)) {
    state.lastChange = now;
  }
  state.height = height;
  const first = state.lastFrame === undefined;
  // Frames stop while idle (requestRenderMode), so cap the step after a pause (at 0.1 s, so
  // slow frame rates still settle in about the same time).
  const dt = first ? 0 : Math.min((now - state.lastFrame) / 1000, 0.1);
  state.lastFrame = now;
  const resting = now - state.lastChange >= REST_DELAY_MS;

  let settling = !resting; // keep frames coming until the rest is noticed
  for (const [name, { level, window }] of Object.entries(layers)) {
    let shift = state.shifts[name] ?? 0;
    if (resting) {
      const target = settledShift(level, shift, window);
      shift = first ? target : approach(shift, target, SPEED * dt);
      settling ||= shift !== target;
    }
    state.shifts[name] = shift;
  }
  if (settling) {
    scene.requestRender();
  }
  return state.shifts;
}

// Where in the window (0..length) a level lies, or -1 outside it. The window grows by MARGIN.
function windowPosition(level, [start, end]) {
  const length = end - start + 2 * MARGIN;
  const d = level - (start - MARGIN);
  const f = d - Math.floor(d);
  return f > 0 && f < length ? f : -1;
}

// The shift to rest at: the current one if it already leaves the level outside the window,
// otherwise the nearest of the unshifted level's exits (so shifts stay below one window).
function settledShift(level, shift, window) {
  if (windowPosition(level + shift, window) < 0) {
    return shift;
  }
  const f = windowPosition(level, window);
  if (f < 0) {
    return 0;
  }
  const length = window[1] - window[0] + 2 * MARGIN;
  const down = -f;
  const up = length - f;
  return Math.abs(down - shift) <= Math.abs(up - shift) ? down : up;
}

function approach(value, target, maxStep) {
  return Math.abs(target - value) <= maxStep ? target : value + Math.sign(target - value) * maxStep;
}
