import {
  Cartesian2,
  Color,
  PointPrimitiveCollection,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  defined,
} from "cesium";

export const MIN_POINTS = { polyline: 2, polygon: 3 };
// Clicks closer than this (pixels) to the previous vertex are ignored; this swallows the
// second click of a double-click, which is used to finish the shape.
const DUPLICATE_CLICK_PIXELS = 4;
// Vertex handle size (pixels) at scale 1, and the smallest size it shrinks to (still grabbable).
const HANDLE_PIXELS = 12;
const HANDLE_OUTLINE_PIXELS = 2;
const MIN_HANDLE_PIXELS = 4;

let nextShapeId = 0;

/**
 * Interactive tool for drawing polylines/polygons by clicking vertices and editing them by
 * dragging the vertex handles. Rendering is left to the caller through callbacks:
 *
 *  - onChange(shape): shape.positions changed (shape = { id, type, positions, complete })
 *  - onRemove(shape): shape was deleted
 *  - onHint(text):    status text for the UI
 *
 * Works with the scene's requestRenderMode: it requests a frame whenever it changes its handles.
 */
export default class DrawTool {
  constructor(viewer, { onChange, onRemove, onHint } = {}) {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.onChange = onChange ?? (() => {});
    this.onRemove = onRemove ?? (() => {});
    this.onHint = onHint ?? (() => {});

    this.shapes = [];
    this.active = undefined; // shape being drawn
    this.lastClick = undefined;
    this.dragging = undefined; // { shape, index }
    this.handleScale = 1; // see setHandleScale

    this.handles = this.scene.primitives.add(new PointPrimitiveCollection());
    this.handler = new ScreenSpaceEventHandler(this.scene.canvas);

    // Double-click is ours (finish shape), not the viewer's "track entity".
    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(
      ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    );

    this.handler.setInputAction((e) => this.#onLeftClick(e), ScreenSpaceEventType.LEFT_CLICK);
    this.handler.setInputAction(() => this.finish(), ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    this.handler.setInputAction(() => this.finish(), ScreenSpaceEventType.RIGHT_CLICK);
    this.handler.setInputAction((e) => this.#onMouseMove(e), ScreenSpaceEventType.MOUSE_MOVE);
    this.handler.setInputAction((e) => this.#onLeftDown(e), ScreenSpaceEventType.LEFT_DOWN);
    this.handler.setInputAction(() => this.#onLeftUp(), ScreenSpaceEventType.LEFT_UP);
  }

  /** Begin drawing a new shape of the given type ("polyline" | "polygon"). */
  start(type) {
    this.cancel();
    this.active = {
      id: nextShapeId++,
      type,
      committed: [],
      floating: undefined,
      handles: [],
      complete: false,
      get positions() {
        return this.floating ? [...this.committed, this.floating] : this.committed;
      },
    };
    this.lastClick = undefined;
    this.shapes.push(this.active);
    this.onHint(
      `Drawing ${type}: click to add vertices, double-click or right-click to finish.`,
    );
  }

  /** Finish the shape being drawn; discards it if it has too few vertices. */
  finish() {
    const shape = this.active;
    if (!shape) {
      return;
    }
    this.active = undefined;
    shape.floating = undefined;
    if (shape.committed.length < MIN_POINTS[shape.type]) {
      this.#removeShape(shape);
    } else {
      shape.complete = true;
      this.onChange(shape);
    }
    this.onHint("Drag the white vertex handles to edit. Pick a tool to draw another shape.");
  }

  /** Abort the shape being drawn. */
  cancel() {
    if (this.active) {
      this.#removeShape(this.active);
      this.active = undefined;
    }
  }

  /** Add a finished, editable shape from code (e.g. when restoring a saved scene). */
  addShape(type, positions) {
    if (positions.length < MIN_POINTS[type]) {
      return undefined;
    }
    const shape = {
      id: nextShapeId++,
      type,
      committed: positions.slice(),
      floating: undefined,
      handles: [],
      complete: true,
      get positions() {
        return this.committed;
      },
    };
    this.shapes.push(shape);
    shape.committed.forEach((position, index) => this.#addHandle(shape, index, position));
    this.onChange(shape);
    return shape;
  }

  /**
   * Scale the vertex handles (1 = full size), e.g. to shrink them with the patterns above a
   * max camera height. They never get smaller than MIN_HANDLE_PIXELS, so they stay grabbable.
   */
  setHandleScale(scale) {
    if (scale === this.handleScale) {
      return;
    }
    this.handleScale = scale;
    const { pixelSize, outlineWidth } = this.#handleSize();
    for (const shape of this.shapes) {
      for (const handle of shape.handles) {
        handle.pixelSize = pixelSize;
        handle.outlineWidth = outlineWidth;
      }
    }
    this.scene.requestRender();
  }

  /** Remove every shape. */
  clear() {
    this.active = undefined;
    for (const shape of [...this.shapes]) {
      this.#removeShape(shape);
    }
    this.onHint("Pick a tool to start drawing.");
  }

  destroy() {
    this.clear();
    this.handler.destroy();
    this.scene.primitives.remove(this.handles);
  }

  #pickPosition(windowPosition) {
    return this.scene.camera.pickEllipsoid(windowPosition, this.scene.globe.ellipsoid);
  }

  #onLeftClick(e) {
    const shape = this.active;
    if (!shape) {
      return;
    }
    if (
      this.lastClick &&
      Cartesian2.distance(this.lastClick, e.position) < DUPLICATE_CLICK_PIXELS
    ) {
      return;
    }
    const position = this.#pickPosition(e.position);
    if (!defined(position)) {
      return;
    }
    this.lastClick = Cartesian2.clone(e.position);
    shape.committed.push(position);
    this.#addHandle(shape, shape.committed.length - 1, position);
    shape.floating = undefined;
    this.#notify(shape);
  }

  #onMouseMove(e) {
    const position = this.#pickPosition(e.endPosition);
    if (!defined(position)) {
      return;
    }
    if (this.dragging) {
      const { shape, index } = this.dragging;
      shape.committed[index] = position;
      shape.handles[index].position = position;
      this.scene.requestRender();
      this.onChange(shape);
      return;
    }
    if (this.active && this.active.committed.length > 0) {
      this.active.floating = position;
      this.#notify(this.active);
    }
  }

  #onLeftDown(e) {
    if (this.active) {
      return;
    }
    const picked = this.scene.pick(e.position);
    const id = picked?.id;
    if (id && id.drawToolHandle) {
      this.dragging = { shape: id.shape, index: id.index };
      this.scene.screenSpaceCameraController.enableInputs = false;
      id.point.color = Color.YELLOW;
      this.scene.requestRender();
    }
  }

  #onLeftUp() {
    if (!this.dragging) {
      return;
    }
    const { shape, index } = this.dragging;
    shape.handles[index].color = Color.WHITE;
    this.dragging = undefined;
    this.scene.screenSpaceCameraController.enableInputs = true;
    this.scene.requestRender();
  }

  #addHandle(shape, index, position) {
    const id = { drawToolHandle: true, shape, index, point: undefined };
    const point = this.handles.add({
      position,
      ...this.#handleSize(),
      color: Color.WHITE,
      outlineColor: Color.BLACK,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      id,
    });
    id.point = point;
    shape.handles.push(point);
    this.scene.requestRender();
  }

  #handleSize() {
    const pixelSize = Math.max(HANDLE_PIXELS * this.handleScale, MIN_HANDLE_PIXELS);
    return { pixelSize, outlineWidth: (HANDLE_OUTLINE_PIXELS * pixelSize) / HANDLE_PIXELS };
  }

  #notify(shape) {
    if (shape.positions.length >= MIN_POINTS[shape.type]) {
      this.onChange(shape);
    }
  }

  #removeShape(shape) {
    for (const handle of shape.handles) {
      this.handles.remove(handle);
    }
    shape.handles = [];
    this.shapes = this.shapes.filter((s) => s !== shape);
    this.scene.requestRender();
    this.onRemove(shape);
  }
}
