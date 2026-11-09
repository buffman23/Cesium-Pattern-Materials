import { Cartesian2, Cartesian3 } from "cesium";
import Shape, { Dirty, fieldPosition, fromDegrees, toDegrees } from "./Shape.js";
import ShapeMode from "./ShapeMode.js";
import { heightOf, interpolate, withHeight } from "./geodesy.js";

// Samples per edge when measuring how close the cursor is to it (edges are curves).
const EDGE_SAMPLES = 24;

/**
 * Base for shapes defined by a list of vertices (Polyline, Polygon, Corridor, …): click to
 * add vertices, double-click or right-click to finish; in EDIT_MODE every vertex is a marker
 * (deletable and/or numbered per the marker options) plus a translate marker.
 *
 * Subclasses set `static minVertices` and implement outlineLines / createFillGeometry using
 * {@link VertexShape#drawPositions} (the vertices plus the floating one under the cursor while
 * drawing). With `static singleHeight = true` the shape has one height (shape.height) at
 * altitude; otherwise each vertex keeps its own. With `static insertOnDoubleClick = true`,
 * double-clicking an edge in the editor inserts a vertex there ({@link VertexShape#vertexInsertAt});
 * `static closed = true` includes the closing edge (last vertex back to the first).
 * Subclasses whose edges aren't thin lines adjust the pick with edgeDisplayPosition /
 * edgeReachPixels.
 */
export default class VertexShape extends Shape {
  static minVertices = 2;
  static singleHeight = false;
  static insertOnDoubleClick = false;
  static closed = false;
  static defaultMarkerOptions = { deletable: true };

  static fields = [
    ...super.fields,
    {
      name: "positions",
      label: "Vertices",
      type: "positions",
      min: (s) => s.constructor.minVertices,
      get: (s) => s.positions.map(fieldPosition),
      set: (s, v) => s.setPositions(v.map(fromDegrees)),
    },
  ];

  /**
   * @param {object} [options] Shape options, plus:
   * @param {Cartesian3[]} [options.positions] Initial vertices.
   */
  constructor(options = {}) {
    super(options);
    this.positions = (options.positions ?? []).map((p) => Cartesian3.clone(p));
    this._floating = undefined;
  }

  static stateFromJSON(json) {
    return { positions: (json.positions ?? []).map(fromDegrees) };
  }

  stateToJSON() {
    return { positions: this.positions.map(toDegrees) };
  }

  /** The vertices, with the floating vertex under the cursor while drawing. */
  drawPositions() {
    const positions = this._floating ? [...this.positions, this._floating] : this.positions;
    return positions.map((p) => this.#display(p));
  }

  // Where a vertex is drawn: on the ground, at its own height, or at the shape height.
  #display(position) {
    if (this.clampToGround) {
      return withHeight(position, 0);
    }
    // A copy either way: what's returned goes into geometry and marker specs.
    return this.constructor.singleHeight
      ? withHeight(position, this.height)
      : Cartesian3.clone(position);
  }

  setPositions(positions) {
    this.positions = positions.map((p) => Cartesian3.clone(p));
    this.invalidate(Dirty.GEOMETRY);
  }

  /** Moves one vertex. */
  setVertex(index, position) {
    if (index < 0 || index >= this.positions.length) {
      throw new RangeError(`No vertex ${index}; the shape has ${this.positions.length}.`);
    }
    this.positions[index] = Cartesian3.clone(position);
    this.invalidate(Dirty.GEOMETRY);
  }

  /** Removes one vertex; false (and nothing removed) at the minimum vertex count. */
  removeVertex(index) {
    if (index < 0 || index >= this.positions.length) {
      throw new RangeError(`No vertex ${index}; the shape has ${this.positions.length}.`);
    }
    if (this.positions.length <= this.constructor.minVertices) {
      return false;
    }
    this.positions.splice(index, 1);
    this.invalidate(Dirty.GEOMETRY);
    return true;
  }

  getControlPoints() {
    return this.positions;
  }

  setControlPoints(points) {
    this.positions = points;
  }

  /**
   * Single-height shapes (Corridor): every vertex gets the new height. Shapes whose vertices
   * keep their own heights (Polyline, Polygon): `height` is the shape's base height, and
   * changing it moves every vertex up or down by the same amount, keeping their differences
   * (heights stop at 0). Used by shift+dragging the translate marker and the height field.
   */
  setHeight(height) {
    const previous = this.height;
    super.setHeight(height);
    if (this.constructor.singleHeight) {
      this.positions = this.positions.map((p) => withHeight(p, this.height));
      return;
    }
    const delta = this.height - previous;
    this.positions = this.positions.map((p) => withHeight(p, Math.max(heightOf(p) + delta, 0)));
  }

  isValid() {
    return this.positions.length >= this.constructor.minVertices;
  }

  onDrawClick(position) {
    // Clamped shapes are picked on the ground; store the vertex at the base height anyway,
    // so unclamping the shape later raises it there.
    this.positions.push(this.clampToGround ? withHeight(position, this.height) : position);
    this._floating = undefined;
    this.invalidate(Dirty.GEOMETRY);
    return "continue";
  }

  onDrawMove(position) {
    if (this.positions.length > 0) {
      this._floating = position;
      this.invalidate(Dirty.FILL | Dirty.OUTLINE);
    }
  }

  onDrawFinishRequest() {
    this._floating = undefined;
    this.finishDrawing();
  }

  finishDrawing() {
    this._floating = undefined;
    return super.finishDrawing();
  }

  drawHint() {
    const n = this.positions.length;
    const min = this.constructor.minVertices;
    const name = this.constructor.type;
    return n < min
      ? `Drawing ${name}: click to add vertices (at least ${min}). Esc cancels.`
      : `Drawing ${name}: ${n} vertices. Click to add more; double-click or right-click to finish.`;
  }

  cursorMessage() {
    if (this._mode !== ShapeMode.DRAW) {
      return undefined;
    }
    return this.positions.length < this.constructor.minVertices
      ? "Click to add vertex"
      : "Click to add vertex\nDouble-click or right-click to finish";
  }

  markerSpecs() {
    const o = this.markerOptions;
    const canDelete =
      o.deletable && this._mode === ShapeMode.EDIT && this.positions.length > this.constructor.minVertices;
    const specs = this.positions.map((position, index) => ({
      key: `v${index}`,
      position: this.#display(position),
      role: "vertex",
      index,
      deletable: canDelete,
      label: o.numbered ? index + 1 : undefined,
    }));
    return [...specs, ...this.translateSpec(), ...this.extraMarkerSpecs()];
  }

  /** More markers for subclasses (e.g. Corridor's width marker). */
  extraMarkerSpecs() {
    return [];
  }

  onMarkerDrag(spec, position) {
    if (spec.role === "vertex") {
      // A drag moves the vertex sideways only; it keeps its own height (a clamped shape is
      // dragged on the ground, which would otherwise set it to 0).
      this.positions[spec.index] = withHeight(position, heightOf(this.positions[spec.index]));
      this.invalidate(Dirty.GEOMETRY);
    }
  }

  onMarkerHeight(spec, height) {
    if (spec.role === "vertex" && !this.constructor.singleHeight) {
      this.positions[spec.index] = withHeight(this.positions[spec.index], Math.max(height, 0));
      this.invalidate(Dirty.GEOMETRY);
    } else {
      this.setHeight(height);
    }
  }

  markerHeight(spec) {
    if (spec.role === "vertex" && !this.constructor.singleHeight) {
      return heightOf(this.positions[spec.index]);
    }
    return this.height;
  }

  deleteMarker(spec) {
    return spec.role === "vertex" && this.removeVertex(spec.index);
  }

  /**
   * Where a vertex would go for a click at `windowPosition`: the edge nearest the cursor on
   * screen (within `tolerancePixels`, plus {@link VertexShape#edgeReachPixels}), as
   * { index, position } - insert `position` before `index` to split that edge. The position
   * lies on the edge (heights interpolated). undefined when no edge is close enough.
   */
  vertexInsertAt(scene, windowPosition, tolerancePixels = 8) {
    const stored = this.positions;
    const n = stored.length;
    const edges = this.constructor.closed && n >= 3 ? n : n - 1;
    let best;
    for (let i = 0; i < edges; i++) {
      const j = (i + 1) % n;
      const a = this.edgeDisplayPosition(i);
      const b = this.edgeDisplayPosition(j);
      let previous;
      for (let k = 0; k <= EDGE_SAMPLES; k++) {
        const t = k / EDGE_SAMPLES;
        const point = interpolate(a, b, t, this.arcType);
        // Undefined behind the camera; that piece of the edge is skipped.
        const screen = scene.cartesianToCanvasCoordinates(point);
        const reach = screen ? tolerancePixels + this.edgeReachPixels(i, t, point) : 0;
        if (screen && previous) {
          const { distance, fraction } = toSegment(windowPosition, previous.screen, screen);
          if (distance <= Math.max(reach, previous.reach) && (!best || distance < best.distance)) {
            best = { edge: i, t: previous.t + (t - previous.t) * fraction, distance };
          }
        }
        previous = screen ? { screen, t, reach } : undefined;
      }
    }
    if (!best) {
      return undefined;
    }
    const next = (best.edge + 1) % n;
    return {
      index: best.edge + 1,
      position: interpolate(stored[best.edge], stored[next], best.t, this.arcType),
    };
  }

  /** Where vertex `index` is drawn, for measuring screen distance to its edges. */
  edgeDisplayPosition(index) {
    return this.#display(this.positions[index]);
  }

  /**
   * Extra pixels beyond the pick tolerance that still count as on the edge, at fraction `t`
   * along edge `edge` (at `point`): 0 for a thin line; a Corridor's on-screen width.
   */
  edgeReachPixels() {
    return 0;
  }

  /** Inserts a vertex before `index` (e.g. for custom insert markers). */
  insertVertex(index, position) {
    this.positions.splice(index, 0, Cartesian3.clone(position));
    this.invalidate(Dirty.GEOMETRY);
  }
}

// Screen distance from p to the segment a-b, and how far along it (0..1) the nearest point is.
const scratch = new Cartesian2();
function toSegment(p, a, b) {
  const ab = Cartesian2.subtract(b, a, scratch);
  const lengthSquared = Cartesian2.magnitudeSquared(ab);
  const fraction =
    lengthSquared > 0
      ? Math.min(Math.max(((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / lengthSquared, 0), 1)
      : 0;
  const dx = a.x + ab.x * fraction - p.x;
  const dy = a.y + ab.y * fraction - p.y;
  return { distance: Math.hypot(dx, dy), fraction };
}
