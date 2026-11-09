import { Cartesian3, Math as CesiumMath } from "cesium";
import Shape, { Dirty, fieldPosition, fromDegrees, toDegrees } from "./Shape.js";
import ShapeMode from "./ShapeMode.js";
import {
  arrivalBearing,
  bearing,
  densify,
  destination,
  distance,
  interpolate,
  offsetLine,
} from "./geodesy.js";

const HALF_PI = CesiumMath.PI_OVER_TWO;
const LINE2_PIECES = 64; // line 1 is split into this many pieces to offset it into line 2
const OFFSET_SAMPLES = 32; // coarse samples along line 1 when finding the point nearest the cursor
const GOLDEN = (1 + Math.sqrt(5)) / 2;
const MAX_EXTENSION = 5_000_000; // meters line 1 is extended past each end when measuring the offset

/**
 * Two parallel lines. Line 1 runs from `anchor1` to `anchor2` (following the arc type); line 2
 * stays `offset` meters beside it all along its length (positive = to the right of
 * anchor1 → anchor2, negative = left), so on a long line it is a curve at a constant
 * distance, not a straight geodesic. No fill.
 *
 * Drawn by clicking anchor 1, anchor 2, then the side and distance of line 2. Editing: drag an
 * end marker (white square) to move that end (the other stays put, the distance is kept), or
 * the white square at the middle of line 2 to change the distance (dragging it across line 1
 * moves line 2 to the other side). A translate marker at the middle of line 1. One height for
 * the whole shape at altitude.
 */
export default class ParallelLines extends Shape {
  static type = "ParallelLines";
  static hasFill = false;

  static fields = [
    ...super.fields,
    {
      name: "anchor1",
      label: "Anchor 1",
      type: "position",
      get: (s) => (s.anchor1 ? fieldPosition(s.atPointHeight(s.anchor1)) : null),
      set: (s, v) => s.setAnchor1(fromDegrees(v)),
    },
    {
      name: "anchor2",
      label: "Anchor 2",
      type: "position",
      get: (s) => (s.anchor2 ? fieldPosition(s.atPointHeight(s.anchor2)) : null),
      set: (s, v) => s.setAnchor2(fromDegrees(v)),
    },
    {
      name: "distance",
      label: "Distance",
      type: "distance",
      min: 0,
      get: (s) => Math.abs(s.offset),
      set: (s, v) => s.setOffset((s.offset < 0 ? -1 : 1) * v),
    },
    {
      name: "side",
      label: "Line 2 side",
      type: "enum",
      options: ["right", "left"],
      get: (s) => (s.offset < 0 ? "left" : "right"),
      set: (s, v) => s.setOffset((v === "left" ? -1 : 1) * Math.abs(s.offset)),
    },
  ];

  /**
   * @param {object} [options] Shape options, plus:
   * @param {Cartesian3} [options.anchor1] With anchor2: the ends of line 1.
   * @param {Cartesian3} [options.anchor2]
   * @param {number} [options.offset=0] Meters from line 1 to line 2: positive to the right of
   *   anchor1 → anchor2, negative to the left.
   */
  constructor(options = {}) {
    super(options);
    this.anchor1 = options.anchor1 && Cartesian3.clone(options.anchor1);
    this.anchor2 = options.anchor2 && Cartesian3.clone(options.anchor2);
    this.offset = options.offset ?? 0;
    this._drawStep = this.anchor1 && this.anchor2 ? 3 : 0; // 0: anchor 1, 1: anchor 2, 2: offset
  }

  static stateFromJSON(json) {
    return {
      anchor1: json.anchor1 && fromDegrees(json.anchor1),
      anchor2: json.anchor2 && fromDegrees(json.anchor2),
      offset: json.offset,
    };
  }

  stateToJSON() {
    return {
      anchor1: this.anchor1 && toDegrees(this.anchor1),
      anchor2: this.anchor2 && toDegrees(this.anchor2),
      offset: this.offset,
    };
  }

  // --- Geometry ----------------------------------------------------------------------------

  /** Length of line 1 (meters). */
  get length() {
    return this.anchor1 && this.anchor2 ? distance(this.anchor1, this.anchor2, this.arcType) : 0;
  }

  /** [anchor1, anchor2] at the shape's point height ([] before anchor 1 is set). */
  line1() {
    if (!this.anchor1) {
      return [];
    }
    const a1 = this.atPointHeight(this.anchor1);
    return [a1, this.anchor2 ? this.atPointHeight(this.anchor2) : a1];
  }

  /** Line 2: line 1 densified and offset by `offset` at every point. */
  line2() {
    const line = this.line1();
    const length = this.length;
    if (line.length < 2 || !(length > 0) || this.offset === 0) {
      return [];
    }
    const pieces = densify(line, this.arcType, Math.max(length / LINE2_PIECES, 1));
    return offsetLine(pieces, this.offset, this.arcType);
  }

  // Middle of line 1, and the direction of line 1 there.
  #middle() {
    const [a1, a2] = this.line1();
    const mid = interpolate(a1, a2, 0.5, this.arcType);
    return { mid, along: bearing(mid, a2, this.arcType) };
  }

  /** The middle of line 2 (where its marker sits). */
  line2Middle() {
    const { mid, along } = this.#middle();
    return destination(mid, along + Math.sign(this.offset) * HALF_PI, Math.abs(this.offset), this.arcType);
  }

  // Signed offset from a point beside line 1: its distance to the nearest point of line 1
  // extended past both ends (so a cursor beyond an end still measures straight across, as
  // across an endless line), positive to the right. Found on the line itself, so it's exact
  // for rhumb lines too (crossTrackDistance is a spherical approximation that drifts there).
  #offsetAt(position) {
    const [a1, a2] = this.line1();
    const arcType = this.arcType;
    // Far enough that the nearest point is on an extension, capped well short of wrapping
    // around the globe.
    const reach = Math.min(Math.max(this.length, distance(a1, position), distance(a2, position)) * 2, MAX_EXTENSION);
    const before = destination(a1, bearing(a1, a2, arcType) + Math.PI, reach, arcType);
    const after = destination(a2, arrivalBearing(a1, a2, arcType), reach, arcType);
    let best;
    for (const [a, b] of [[before, a1], [a1, a2], [a2, after]]) {
      const hit = nearestOnSegment(a, b, position, arcType);
      if (!best || hit.meters < best.meters) {
        best = { ...hit, a, b };
      }
    }
    const meters = distance(best.foot, position, arcType);
    if (!(meters > 0)) {
      return 0;
    }
    // Right or left of the direction of travel at the foot.
    const along = best.t < 1 ? bearing(best.foot, best.b, arcType) : arrivalBearing(best.a, best.b, arcType);
    const side = Math.sin(bearing(best.foot, position, arcType) - along);
    return side < 0 ? -meters : meters;
  }

  isValid() {
    return Boolean(this.anchor1 && this.anchor2) && this.length > 0 && this.offset !== 0;
  }

  createFillGeometry() {
    return undefined;
  }

  outlineLines() {
    if (!(this.length > 0)) {
      return [];
    }
    const lines = [{ positions: this.line1(), loop: false, key: "line1" }];
    const line2 = this.line2();
    if (line2.length >= 2) {
      lines.push({ positions: line2, loop: false, key: "line2" });
    }
    return lines;
  }

  // --- Setters -----------------------------------------------------------------------------

  setAnchors(anchor1, anchor2) {
    this.anchor1 = Cartesian3.clone(anchor1);
    this.anchor2 = Cartesian3.clone(anchor2);
    this.invalidate(Dirty.GEOMETRY);
  }

  /** Moves anchor 1; anchor 2 stays put. */
  setAnchor1(anchor) {
    this.setAnchors(anchor, this.anchor2 ?? anchor);
  }

  /** Moves anchor 2; anchor 1 stays put. */
  setAnchor2(anchor) {
    this.setAnchors(this.anchor1 ?? anchor, anchor);
  }

  /** Meters from line 1 to line 2: positive to the right of anchor1 → anchor2, negative left. */
  setOffset(offset) {
    this.offset = Number.isFinite(offset) ? offset : 0;
    this.invalidate(Dirty.GEOMETRY);
  }

  // --- Translate ---------------------------------------------------------------------------

  getControlPoints() {
    return this.anchor1 && this.anchor2 ? [this.anchor1, this.anchor2] : [];
  }

  setControlPoints([a1, a2]) {
    if (a1 && a2) {
      this.anchor1 = a1;
      this.anchor2 = a2;
    }
  }

  translateAnchor() {
    return this.length > 0 ? this.#middle().mid : undefined;
  }

  // --- Drawing -----------------------------------------------------------------------------

  onDrawClick(position) {
    if (this._drawStep === 0) {
      this.anchor1 = Cartesian3.clone(position);
      this.anchor2 = Cartesian3.clone(position);
      this.offset = 0;
      this._drawStep = 1;
    } else if (this._drawStep === 1) {
      this.anchor2 = Cartesian3.clone(position);
      if (!(this.length > 0)) {
        return "continue"; // same point again: wait for a real second point
      }
      this._drawStep = 2;
    } else {
      this.offset = this.#offsetAt(position);
      if (this.offset === 0) {
        return "continue";
      }
      this._drawStep = 3;
      this.invalidate(Dirty.GEOMETRY);
      return "done";
    }
    this.invalidate(Dirty.GEOMETRY);
    return "continue";
  }

  onDrawMove(position) {
    if (this._drawStep === 1) {
      this.anchor2 = Cartesian3.clone(position);
      this.invalidate(Dirty.GEOMETRY);
    } else if (this._drawStep === 2) {
      this.offset = this.#offsetAt(position);
      this.invalidate(Dirty.GEOMETRY);
    }
  }

  cursorMessage() {
    if (this._mode !== ShapeMode.DRAW) {
      return undefined;
    }
    return ["Click to set anchor 1", "Click to set anchor 2", "Click to set the parallel line"][this._drawStep];
  }

  drawHint() {
    const steps = [
      "click anchor 1 (one end of the first line)",
      "click anchor 2 (the other end)",
      "move sideways and click to place the parallel line",
    ];
    return steps[this._drawStep] ? `Drawing Parallel lines: ${steps[this._drawStep]}. Esc cancels.` : "";
  }

  // --- Markers -----------------------------------------------------------------------------

  markerSpecs() {
    const [a1, a2] = this.line1();
    if (!a1) {
      return [];
    }
    if (this._mode !== ShapeMode.EDIT) {
      // While drawing: just the points placed so far.
      const specs = [{ key: "anchor1", position: a1, role: "point" }];
      if (this._drawStep >= 2) {
        specs.push({ key: "anchor2", position: a2, role: "point" });
      }
      return specs;
    }
    const numbered = this.markerOptions.numbered;
    const specs = [a1, a2].map((position, index) => ({
      key: `anchor${index + 1}`,
      position,
      role: "anchor",
      index,
      label: numbered ? index + 1 : undefined,
    }));
    if (this.length > 0) {
      const { mid, along } = this.#middle();
      const bearingOut = along + (this.offset < 0 ? -HALF_PI : HALF_PI);
      const position = this.line2Middle();
      // axis: the direction the distance changes in, at the marker (for the resize icon).
      const axis = this.offset !== 0 ? arrivalBearing(mid, position, this.arcType) : bearingOut;
      specs.push({ key: "offset", position, role: "offset", axis });
      specs.push(...this.translateSpec(mid));
    }
    return specs;
  }

  onMarkerDrag(spec, position) {
    if (spec.role === "anchor") {
      if (spec.index === 0) {
        this.setAnchor1(position);
      } else {
        this.setAnchor2(position);
      }
    } else if (spec.role === "offset") {
      this.setOffset(this.#offsetAt(position));
    }
  }
}

Shape.register(ParallelLines);

// The point of the path a → b (along arcType) nearest `position`: { t, foot, meters }.
// Coarse samples, then a golden-section search around the nearest one.
function nearestOnSegment(a, b, position, arcType) {
  const at = (t) => interpolate(a, b, t, arcType);
  const away = (t) => distance(at(t), position);
  let best = 0;
  let bestMeters = away(0);
  for (let k = 1; k <= OFFSET_SAMPLES; k++) {
    const meters = away(k / OFFSET_SAMPLES);
    if (meters < bestMeters) {
      best = k;
      bestMeters = meters;
    }
  }
  let lo = Math.max(best - 1, 0) / OFFSET_SAMPLES;
  let hi = Math.min(best + 1, OFFSET_SAMPLES) / OFFSET_SAMPLES;
  for (let i = 0; i < 40; i++) {
    const m1 = hi - (hi - lo) / GOLDEN;
    const m2 = lo + (hi - lo) / GOLDEN;
    if (away(m1) < away(m2)) {
      hi = m2;
    } else {
      lo = m1;
    }
  }
  const t = (lo + hi) / 2;
  const foot = at(t);
  return { t, foot, meters: distance(foot, position) };
}
