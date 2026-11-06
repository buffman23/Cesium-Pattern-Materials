import { Cartesian3 } from "cesium";
import Shape, { Dirty, fieldPosition, fromDegrees, toDegrees } from "./Shape.js";
import ShapeMode from "./ShapeMode.js";
import { heightOf, withHeight } from "./geodesy.js";

/**
 * Base for shapes defined by a list of vertices (Polyline, Polygon, Corridor, …): click to
 * add vertices, double-click or right-click to finish; in EDIT_MODE every vertex is a marker
 * (deletable and/or numbered per the marker options) plus a translate marker.
 *
 * Subclasses set `static minVertices` and implement outlineLines / createFillGeometry using
 * {@link VertexShape#drawPositions} (the vertices plus the floating one under the cursor while
 * drawing). With `static singleHeight = true` the shape has one height (shape.height) at
 * altitude; otherwise each vertex keeps its own.
 */
export default class VertexShape extends Shape {
  static minVertices = 2;
  static singleHeight = false;
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

  setHeight(height) {
    super.setHeight(height);
    // At altitude every vertex moves to the new height.
    this.positions = this.positions.map((p) => withHeight(p, this.height));
  }

  isValid() {
    return this.positions.length >= this.constructor.minVertices;
  }

  onDrawClick(position) {
    this.positions.push(position);
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
      this.positions[spec.index] = position;
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

  /** Inserts a vertex before `index` (e.g. for custom insert markers). */
  insertVertex(index, position) {
    this.positions.splice(index, 0, Cartesian3.clone(position));
    this.invalidate(Dirty.GEOMETRY);
  }
}
