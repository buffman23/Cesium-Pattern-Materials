import { Cartesian3, Math as CesiumMath } from "cesium";
import Shape, { Dirty, fieldPosition, fromDegrees, toDegrees } from "./Shape.js";
import ShapeMode from "./ShapeMode.js";
import { arrivalBearing, bearing, clockwiseSweep, distance, sampleArc } from "./geodesy.js";

/**
 * A pie slice: from `center` out to `radius` meters, between `startBearing` and
 * `endBearing` (radians clockwise from north; the slice runs clockwise from start to end).
 * The radial edges and the arc's distance follow the shape's arcType. Drawn by clicking the
 * center, then the start of the arc, then its end.
 *
 * Edit markers: the center (moves the sector; shift+drag changes the height at altitude), the
 * arc's start and end (bearing and radius) and its middle (radius; shift+drag rotates the
 * sector about the center instead). One height for the whole sector at altitude.
 */
export default class Sector extends Shape {
  static type = "Sector";

  // Plain white square markers for every handle (no resize / rotate icons), except the
  // radius marker's rotate icon while shift is held.
  static defaultMarkerOptions = { roleStyles: { radius: null, start: null, end: null } };

  static fields = [
    ...super.fields,
    {
      name: "center",
      label: "Center",
      type: "position",
      get: (s) => s.center && fieldPosition(s.center),
      set: (s, v) => s.setCenter(fromDegrees(v)),
    },
    {
      name: "radius",
      label: "Radius",
      type: "distance",
      min: 0,
      get: (s) => s.radius,
      set: (s, v) => s.setRadius(v),
    },
    {
      name: "startBearing",
      label: "Start bearing",
      type: "angle",
      get: (s) => CesiumMath.toDegrees(CesiumMath.zeroToTwoPi(s.startBearing)),
      set: (s, v) => s.setStartBearing(CesiumMath.toRadians(v)),
    },
    {
      name: "endBearing",
      label: "End bearing",
      type: "angle",
      get: (s) => CesiumMath.toDegrees(CesiumMath.zeroToTwoPi(s.endBearing)),
      set: (s, v) => s.setEndBearing(CesiumMath.toRadians(v)),
    },
  ];

  /**
   * @param {object} [options] Shape options, plus:
   * @param {Cartesian3} [options.center]
   * @param {number} [options.radius=0] Meters.
   * @param {number} [options.startBearing=0] Radians.
   * @param {number} [options.endBearing=0] Radians.
   */
  constructor(options = {}) {
    super(options);
    this.center = options.center && Cartesian3.clone(options.center);
    this.radius = options.radius ?? 0;
    this.startBearing = options.startBearing ?? 0;
    this.endBearing = options.endBearing ?? 0;
    this._drawStep = this.center ? 3 : 0; // 0: center, 1: arc start, 2: arc end
  }

  static stateFromJSON(json) {
    return {
      center: json.center && fromDegrees(json.center),
      radius: json.radius,
      startBearing: CesiumMath.toRadians(json.startBearing ?? 0),
      endBearing: CesiumMath.toRadians(json.endBearing ?? 0),
    };
  }

  stateToJSON() {
    return {
      center: this.center && toDegrees(this.center),
      radius: this.radius,
      startBearing: CesiumMath.toDegrees(this.startBearing),
      endBearing: CesiumMath.toDegrees(this.endBearing),
    };
  }

  /** Clockwise angle from start to end, radians. */
  get sweep() {
    return clockwiseSweep(this.startBearing, this.endBearing);
  }

  setCenter(center) {
    this.center = Cartesian3.clone(center);
    this.invalidate(Dirty.GEOMETRY);
  }

  setRadius(radius) {
    this.radius = Math.max(radius, 0);
    this.invalidate(Dirty.GEOMETRY);
  }

  /** Radians clockwise from north. */
  setStartBearing(bearing) {
    this.startBearing = bearing;
    this.invalidate(Dirty.GEOMETRY);
  }

  /** Radians clockwise from north; the sector runs clockwise from the start bearing to it. */
  setEndBearing(bearing) {
    this.endBearing = bearing;
    this.invalidate(Dirty.GEOMETRY);
  }

  getControlPoints() {
    return this.center ? [this.center] : [];
  }

  setControlPoints([center]) {
    this.center = center;
  }

  translateAnchor() {
    return this.center && this.atPointHeight(this.center);
  }

  isValid() {
    return Boolean(this.center) && this.radius > 0 && this.sweep > 1e-6;
  }

  onDrawClick(position) {
    if (this._drawStep === 0) {
      this.center = position;
      this._drawStep = 1;
      this.invalidate(Dirty.GEOMETRY);
      return "continue";
    }
    if (this._drawStep === 1) {
      this.#aim(position, "startBearing");
      this.endBearing = this.startBearing;
      this._drawStep = 2;
      return "continue";
    }
    this.endBearing = bearing(this.center, position, this.arcType);
    this.invalidate(Dirty.GEOMETRY);
    this._drawStep = 3;
    return "done";
  }

  onDrawMove(position) {
    if (this._drawStep === 1) {
      this.#aim(position, "startBearing");
    } else if (this._drawStep === 2) {
      this.endBearing = bearing(this.center, position, this.arcType);
      this.invalidate(Dirty.GEOMETRY);
    }
  }

  #aim(position, key) {
    this.radius = distance(this.center, position, this.arcType);
    this[key] = bearing(this.center, position, this.arcType);
    this.invalidate(Dirty.GEOMETRY);
  }

  drawHint() {
    return [
      "Drawing Sector: click to place the center.",
      "Drawing Sector: click where the arc starts (sets the radius). Esc cancels.",
      "Drawing Sector: move clockwise and click where the arc ends. Esc cancels.",
    ][this._drawStep] ?? "";
  }

  cursorMessage() {
    if (this._mode !== ShapeMode.DRAW) {
      return undefined;
    }
    return [
      "Click to set center",
      "Click to set radius and arc start",
      "Click to set arc end",
    ][this._drawStep];
  }

  #arc() {
    const segments = Math.max(
      4,
      Math.ceil((this.detail.arcSegments / this.detailFactor) * (this.sweep / CesiumMath.TWO_PI)),
    );
    return sampleArc(
      this.center,
      this.radius,
      this.startBearing,
      this.startBearing + this.sweep,
      segments,
      this.arcType,
      this.pointHeight,
    );
  }

  /** Closed boundary: center, then the arc. */
  boundary() {
    if (!this.isValid()) {
      return [];
    }
    return [this.atPointHeight(this.center), ...this.#arc()];
  }

  createFillGeometry() {
    return this.polygonGeometry(this.boundary());
  }

  outlineLines() {
    if (this.isValid()) {
      return [{ positions: this.boundary(), loop: true }];
    }
    // While aiming the first radius: a line from the center to the cursor.
    if (this.center && this.radius > 0) {
      const end = sampleArc(this.center, this.radius, this.startBearing, this.startBearing, 1, this.arcType, this.pointHeight)[0];
      return [{ positions: [this.atPointHeight(this.center), end], loop: false }];
    }
    return [];
  }

  #pointAt(b) {
    return sampleArc(this.center, this.radius, b, b, 1, this.arcType, this.pointHeight)[0];
  }

  markerSpecs() {
    if (!this.center) {
      return [];
    }
    const center = this.atPointHeight(this.center);
    if (this._mode !== ShapeMode.EDIT) {
      return [{ key: "center", position: center, role: "center" }];
    }
    const specs = this.markerOptions.translatable
      ? this.translateSpec(center)
      : [{ key: "center", position: center, role: "center" }];
    if (this.radius > 0) {
      // shiftVertical: false - shift doesn't make these height drags. The radius marker
      // rotates with shift instead, and shows the rotate icon then (shiftRole).
      specs.push(
        { key: "start", position: this.#pointAt(this.startBearing), role: "start", shiftVertical: false },
        { key: "end", position: this.#pointAt(this.startBearing + this.sweep), role: "end", shiftVertical: false },
        {
          key: "mid",
          position: this.#pointAt(this.startBearing + this.sweep / 2),
          role: "radius",
          shiftVertical: false,
          shiftRole: "rotate",
          // axis: outward at the marker (for the resize icon).
          axis: arrivalBearing(this.center, this.#pointAt(this.startBearing + this.sweep / 2), this.arcType),
        },
      );
    }
    return specs;
  }

  onMarkerDrag(spec, position, { shift = false } = {}) {
    if (spec.role === "radius" && shift) {
      // Rotate about the center: the arc's middle follows the cursor, sweep and radius kept.
      const sweep = this.sweep;
      const mid = bearing(this.center, position, this.arcType);
      this.startBearing = mid - sweep / 2;
      this.endBearing = mid + sweep / 2;
      this.invalidate(Dirty.GEOMETRY);
    } else if (spec.role === "start") {
      this.#aim(position, "startBearing");
    } else if (spec.role === "end") {
      this.#aim(position, "endBearing");
    } else if (spec.role === "radius") {
      this.radius = distance(this.center, position, this.arcType);
      this.invalidate(Dirty.GEOMETRY);
    } else if (spec.role === "center") {
      this.center = position;
      this.invalidate(Dirty.GEOMETRY);
    }
  }
}

Shape.register(Sector);
