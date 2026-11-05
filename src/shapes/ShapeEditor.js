import {
  BillboardCollection,
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Ellipsoid,
  Event,
  GroundPrimitive,
  KeyboardEventModifier,
  PolylineCollection,
  PrimitiveCollection,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  defined,
} from "cesium";
import Shape from "./Shape.js";
import ShapeMode from "./ShapeMode.js";

// Clicks closer than this (pixels) to the previous one are ignored while drawing; this
// swallows the second click of a double-click.
const DUPLICATE_CLICK_PIXELS = 4;

/**
 * Owns everything shapes share: mouse input, the selected (edited) shape, the marker
 * billboards and the once-per-frame rebuild of changed shapes. One per viewer.
 *
 *   const editor = await ShapeEditor.create(viewer);
 *   const circle = editor.startDrawing(Circle, { fill: { material: Color.RED.withAlpha(0.3) } });
 *
 * Input: while a shape is in DRAW_MODE, clicks and moves go to it (double-click / right-click
 * ask it to finish, Esc cancels). Otherwise: drag a marker to edit, shift+drag to change its
 * height (at altitude), click a marker's red X to delete it, click a shape to edit it, click
 * empty globe or press Esc to stop editing.
 *
 * Works with requestRenderMode: everything that changes requests a frame.
 */
export default class ShapeEditor {
  /** Creates an editor once ground primitives can be built synchronously. */
  static async create(viewer) {
    await GroundPrimitive.initializeTerrainHeights();
    return new ShapeEditor(viewer);
  }

  constructor(viewer) {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.shapes = [];
    this.selected = undefined;
    this.drawing = undefined;

    this.shapeAdded = new Event();
    this.shapeRemoved = new Event();
    this.selectionChanged = new Event(); // (shape | undefined, previous | undefined)
    this.hint = new Event(); // (text)

    this.primitives = this.scene.primitives.add(new PrimitiveCollection());
    this.groundLines = this.scene.primitives.add(new PolylineCollection());
    this.billboards = this.scene.primitives.add(new BillboardCollection({ scene: this.scene }));

    this._dirty = new Set();
    this._dragging = undefined;
    this._lastClick = undefined;
    this._hoverPosition = undefined;
    this._hoverFrame = undefined;
    this._shift = false;
    this._grownEllipsoids = new Map();

    this.#bindInput(viewer);
    this._removePreRender = this.scene.preRender.addEventListener(() => this.#onPreRender());
    this._removePostRender = this.scene.postRender.addEventListener(() => this.#onPostRender());
  }

  // --- Shapes ----------------------------------------------------------------------------------

  /** Adds a finished shape (e.g. from Shape.fromJSON); it starts IDLE. */
  add(shape) {
    if (shape.editor === this) {
      return shape;
    }
    shape.editor = this;
    this.shapes.push(shape);
    shape.invalidate();
    this.shapeAdded.raiseEvent(shape);
    return shape;
  }

  remove(shape) {
    if (shape.editor !== this) {
      return;
    }
    if (this.selected === shape) {
      this.deselect();
    }
    if (this.drawing === shape) {
      this.drawing = undefined;
      this.#emitHint("");
    }
    if (this._dragging?.shape === shape) {
      this.#endDrag();
    }
    shape._destroyRender();
    this._dirty.delete(shape);
    this.shapes = this.shapes.filter((s) => s !== shape);
    shape.editor = undefined;
    this.scene.requestRender();
    this.shapeRemoved.raiseEvent(shape);
  }

  clear() {
    this.drawing?.cancelDrawing();
    for (const shape of [...this.shapes]) {
      this.remove(shape);
    }
  }

  /**
   * Starts drawing a new shape. The shape class's constructor gets `options`. Any shape being
   * drawn is cancelled first.
   */
  startDrawing(ShapeClass, options = {}) {
    this.drawing?.cancelDrawing();
    this.deselect();
    const shape = this.add(new ShapeClass(options));
    this.drawing = shape;
    this._lastClick = undefined;
    shape._setMode(ShapeMode.DRAW);
    this.#emitHint(shape.drawHint());
    return shape;
  }

  /** Puts a shape in EDIT_MODE (one at a time). */
  select(shape) {
    if (shape === this.selected || shape.editor !== this || shape.mode === ShapeMode.DRAW) {
      return;
    }
    const previous = this.selected;
    previous?._setMode(ShapeMode.IDLE);
    this.selected = shape;
    shape._setMode(ShapeMode.EDIT);
    this.#emitHint(
      "Drag the markers to edit (shift+drag changes height at altitude). " +
        "Click elsewhere or press Esc to stop editing.",
    );
    this.selectionChanged.raiseEvent(shape, previous);
  }

  deselect() {
    const previous = this.selected;
    if (!previous) {
      return;
    }
    this.selected = undefined;
    previous._setMode(ShapeMode.IDLE);
    this.#setCursor("");
    this.#emitHint("Click a shape to edit it, or pick a tool to draw another.");
    this.selectionChanged.raiseEvent(undefined, previous);
  }

  destroy() {
    this.clear();
    this.handler.destroy();
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("blur", this._onBlur);
    this._removePreRender();
    this._removePostRender();
    if (this._hoverFrame) {
      cancelAnimationFrame(this._hoverFrame);
    }
    this.scene.primitives.remove(this.primitives);
    this.scene.primitives.remove(this.groundLines);
    this.scene.primitives.remove(this.billboards);
  }

  // Called by shapes.
  _requestFlush(shape) {
    if (shape.editor === this) {
      this._dirty.add(shape);
      this.scene.requestRender();
    }
  }

  _finishedDrawing(shape) {
    if (this.drawing === shape) {
      this.drawing = undefined;
    }
    shape._setMode(ShapeMode.IDLE);
    this.select(shape);
  }

  // --- Picking positions -------------------------------------------------------------------

  /**
   * The globe position under a window position, at `height` meters above the ellipsoid
   * (picked on the ellipsoid grown by that height, so markers stay under the cursor at
   * altitude).
   */
  pickPosition(windowPosition, height = 0) {
    const ellipsoid = this.#grownEllipsoid(height);
    const picked = this.scene.camera.pickEllipsoid(windowPosition, ellipsoid);
    if (!defined(picked)) {
      return undefined;
    }
    if (height === 0) {
      return picked;
    }
    const c = Ellipsoid.WGS84.cartesianToCartographic(picked, new Cartographic());
    return c && Cartesian3.fromRadians(c.longitude, c.latitude, height);
  }

  #grownEllipsoid(height) {
    if (!(height > 0)) {
      return Ellipsoid.WGS84;
    }
    const key = Math.round(height * 10) / 10; // 10 cm buckets
    let ellipsoid = this._grownEllipsoids.get(key);
    if (!ellipsoid) {
      if (this._grownEllipsoids.size > 64) {
        this._grownEllipsoids.clear();
      }
      const r = Ellipsoid.WGS84.radii;
      ellipsoid = new Ellipsoid(r.x + key, r.y + key, r.z + key);
      this._grownEllipsoids.set(key, ellipsoid);
    }
    return ellipsoid;
  }

  // --- Input ---------------------------------------------------------------------------------

  #bindInput(viewer) {
    // Double-click is ours (finish shape), not the viewer's "track entity".
    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(
      ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    );
    this.handler = new ScreenSpaceEventHandler(this.scene.canvas);
    const actions = {
      [ScreenSpaceEventType.LEFT_CLICK]: (e) => this.#onLeftClick(e),
      [ScreenSpaceEventType.LEFT_DOUBLE_CLICK]: () => this.drawing?.onDrawFinishRequest("double"),
      [ScreenSpaceEventType.RIGHT_CLICK]: () => this.drawing?.onDrawFinishRequest("right"),
      [ScreenSpaceEventType.MOUSE_MOVE]: (e) => this.#onMouseMove(e),
      [ScreenSpaceEventType.LEFT_DOWN]: (e) => this.#onLeftDown(e),
      [ScreenSpaceEventType.LEFT_UP]: () => this.#endDrag(),
    };
    // With a modifier held, Cesium only calls the actions registered for that modifier.
    for (const [type, action] of Object.entries(actions)) {
      for (const modifier of [undefined, KeyboardEventModifier.SHIFT]) {
        this.handler.setInputAction(action, Number(type), modifier);
      }
    }
    this._onKeyDown = (e) => {
      if (e.key === "Shift") {
        this._shift = true;
      } else if (e.key === "Escape") {
        if (this.drawing) {
          this.drawing.cancelDrawing();
        } else {
          this.deselect();
        }
      }
    };
    this._onKeyUp = (e) => {
      if (e.key === "Shift") {
        this._shift = false;
      }
    };
    this._onBlur = () => {
      this._shift = false;
    };
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("blur", this._onBlur);
  }

  #emitHint(text) {
    this.hint.raiseEvent(text);
  }

  #setCursor(cursor) {
    if (this.scene.canvas.style.cursor !== cursor) {
      this.scene.canvas.style.cursor = cursor;
    }
  }

  #pickedId(windowPosition) {
    const picked = this.scene.pick(windowPosition);
    const id = picked?.id;
    return id?.shape instanceof Shape && id.shape.editor === this ? id : undefined;
  }

  #onLeftClick(e) {
    const shape = this.drawing;
    if (shape) {
      if (this._lastClick && Cartesian2.distance(this._lastClick, e.position) < DUPLICATE_CLICK_PIXELS) {
        return;
      }
      const position = this.pickPosition(e.position, shape.pointHeight);
      if (!position) {
        return;
      }
      this._lastClick = Cartesian2.clone(e.position);
      const result = shape.onDrawClick(position);
      if (result === "done") {
        shape.finishDrawing();
      } else if (this.drawing === shape) {
        this.#emitHint(shape.drawHint());
      }
      return;
    }
    if (this._clickConsumed) {
      this._clickConsumed = false; // the click ending a marker drag
      return;
    }
    const id = this.#pickedId(e.position);
    if (!id) {
      this.deselect();
      return;
    }
    if (id.kind === "delete") {
      const spec = id.shape.markers?.spec(id.key);
      if (spec && id.shape.deleteMarker(spec)) {
        id.shape.markers.setHover(undefined);
        id.shape.markers.setSelected(undefined);
      }
      return;
    }
    if (id.kind === "marker") {
      id.shape.markers?.setSelected(id.key);
      return;
    }
    this.select(id.shape);
  }

  #onLeftDown(e) {
    if (this.drawing || !this.selected) {
      return;
    }
    const id = this.#pickedId(e.position);
    if (id?.kind !== "marker" || id.shape !== this.selected) {
      return;
    }
    const shape = id.shape;
    const spec = shape.markers?.spec(id.key);
    if (!spec) {
      return;
    }
    const height = shape.clampToGround ? 0 : shape.markerHeight(spec);
    this._dragging = {
      shape,
      key: id.key,
      height,
      last: this.pickPosition(e.position, height) ?? spec.position,
      moved: false,
    };
    this.scene.screenSpaceCameraController.enableInputs = false;
    shape._setInteractive(true);
    shape.markers.setSelected(id.key);
    shape.markers.setActive(id.key);
  }

  #endDrag() {
    const drag = this._dragging;
    if (!drag) {
      return;
    }
    this._dragging = undefined;
    this.scene.screenSpaceCameraController.enableInputs = true;
    drag.shape.markers?.setActive(undefined);
    drag.shape._setInteractive(false);
    // A drag that moved must not also count as a click on whatever is under the cursor.
    this._clickConsumed = drag.moved;
    setTimeout(() => {
      this._clickConsumed = false;
    }, 0);
  }

  #onMouseMove(e) {
    const drag = this._dragging;
    if (drag) {
      this.#drag(drag, e);
      return;
    }
    const shape = this.drawing;
    if (shape) {
      const position = this.pickPosition(e.endPosition, shape.pointHeight);
      if (position) {
        shape.onDrawMove(position);
      }
      return;
    }
    // Hover: pick at most once per animation frame (scene.pick is expensive).
    this._hoverPosition = Cartesian2.clone(e.endPosition, this._hoverPosition);
    this._hoverFrame ??= requestAnimationFrame(() => {
      this._hoverFrame = undefined;
      this.#hover(this._hoverPosition);
    });
  }

  #drag(drag, e) {
    const { shape } = drag;
    const spec = shape.markers?.spec(drag.key);
    if (!spec) {
      return;
    }
    drag.moved = true;
    if (this._shift && !shape.clampToGround) {
      // Vertical drag: pixels up -> meters up, at the marker's distance from the camera.
      const pixels = e.startPosition.y - e.endPosition.y;
      const scene = this.scene;
      const metersPerPixel =
        scene.camera.getPixelSize(
          new BoundingSphere(spec.position, 0),
          scene.drawingBufferWidth,
          scene.drawingBufferHeight,
        ) *
        (scene.drawingBufferHeight / Math.max(scene.canvas.clientHeight, 1));
      drag.height = Math.max(drag.height + pixels * metersPerPixel, 0);
      shape.onMarkerHeight(spec, drag.height);
      return;
    }
    const position = this.pickPosition(e.endPosition, drag.height);
    if (!position) {
      return;
    }
    if (spec.role === "translate") {
      shape.translate(drag.last, position);
    } else {
      shape.onMarkerDrag(spec, position);
    }
    drag.last = position;
  }

  #hover(windowPosition) {
    if (this._dragging || this.drawing) {
      return;
    }
    const id = this.#pickedId(windowPosition);
    const markers = this.selected?.markers;
    if (markers) {
      const own = id && id.shape === this.selected && (id.kind === "marker" || id.kind === "delete");
      markers.setHover(own ? id.key : undefined);
    }
    let cursor = "";
    if (id?.kind === "marker") {
      cursor = markers?.spec(id.key)?.role === "translate" ? "move" : "grab";
    } else if (id) {
      cursor = "pointer";
    }
    this.#setCursor(cursor);
  }

  // --- Frame ---------------------------------------------------------------------------------

  #onPreRender() {
    // Rebuild each changed shape once, however many mouse events changed it.
    if (this._dirty.size > 0) {
      const dirty = [...this._dirty];
      this._dirty.clear();
      for (const shape of dirty) {
        shape._flush();
      }
    }
    const camera = this.scene.camera;
    const cullingVolume = camera.frustum.computeCullingVolume(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    );
    let loading = false;
    for (const shape of this.shapes) {
      loading = shape._updateFrame(this.scene, cullingVolume) || loading;
    }
    // Marker images (SVG data URIs, custom URLs) load asynchronously too.
    loading ||= Boolean(this.selected?.markers?.loading || this.drawing?.markers?.loading);
    this._loading = loading;
  }

  #onPostRender() {
    // Keep rendering while pattern or marker images are still loading.
    if (this._loading || this._dirty.size > 0) {
      this.scene.requestRender();
    }
  }
}
