import { Cartesian3, Cartographic, Math as CesiumMath } from "cesium";
import Shape, { Dirty, fromDegrees, toDegrees } from "./Shape.js";
import ShapeMode from "./ShapeMode.js";
import { toCartographic } from "./geodesy.js";

const MAX_LATITUDE = CesiumMath.toRadians(89.9);

/**
 * A longitude/latitude box given by two opposite corners. With ArcType.RHUMB its edges run
 * along parallels and meridians (a Cesium Rectangle); with ArcType.GEODESIC the same four
 * corners are joined by geodesics, so the north and south edges bow towards the pole.
 * Drawn by clicking one corner, then the opposite one. Doesn't cross the antimeridian.
 *
 * Edit markers: the four corners (the opposite corner stays put) and a translate marker in
 * the middle. One height for the whole rectangle at altitude.
 */
export default class Rectangle extends Shape {
  static type = "Rectangle";

  /**
   * @param {object} [options] Shape options, plus:
   * @param {Cartesian3} [options.cornerA]
   * @param {Cartesian3} [options.cornerB] The corner opposite cornerA.
   */
  constructor(options = {}) {
    super(options);
    this.cornerA = options.cornerA && Cartesian3.clone(options.cornerA);
    this.cornerB = options.cornerB && Cartesian3.clone(options.cornerB);
  }

  static stateFromJSON(json) {
    return {
      cornerA: json.cornerA && fromDegrees(json.cornerA),
      cornerB: json.cornerB && fromDegrees(json.cornerB),
    };
  }

  stateToJSON() {
    return {
      cornerA: this.cornerA && toDegrees(this.cornerA),
      cornerB: this.cornerB && toDegrees(this.cornerB),
    };
  }

  setCorners(cornerA, cornerB) {
    this.cornerA = Cartesian3.clone(cornerA);
    this.cornerB = Cartesian3.clone(cornerB);
    this.invalidate(Dirty.GEOMETRY);
  }

  getControlPoints() {
    return [this.cornerA, this.cornerB].filter(Boolean);
  }

  setControlPoints([a, b]) {
    this.cornerA = a;
    this.cornerB = b;
  }

  /** { west, south, east, north } in radians, or undefined. */
  bounds() {
    if (!this.cornerA || !this.cornerB) {
      return undefined;
    }
    const a = toCartographic(this.cornerA);
    const b = toCartographic(this.cornerB);
    return {
      west: Math.min(a.longitude, b.longitude),
      east: Math.max(a.longitude, b.longitude),
      south: Math.min(a.latitude, b.latitude),
      north: Math.max(a.latitude, b.latitude),
    };
  }

  /** Corners NW, NE, SE, SW at the shape's point height. */
  corners() {
    const r = this.bounds();
    if (!r) {
      return [];
    }
    const h = this.pointHeight;
    return [
      Cartesian3.fromRadians(r.west, r.north, h),
      Cartesian3.fromRadians(r.east, r.north, h),
      Cartesian3.fromRadians(r.east, r.south, h),
      Cartesian3.fromRadians(r.west, r.south, h),
    ];
  }

  isValid() {
    const r = this.bounds();
    return Boolean(r) && r.east - r.west > 1e-9 && r.north - r.south > 1e-9;
  }

  onDrawClick(position) {
    if (!this.cornerA) {
      this.cornerA = position;
      this.cornerB = position;
      this.invalidate(Dirty.GEOMETRY);
      return "continue";
    }
    this.cornerB = position;
    this.invalidate(Dirty.GEOMETRY);
    return "done";
  }

  onDrawMove(position) {
    if (this.cornerA) {
      this.cornerB = position;
      this.invalidate(Dirty.GEOMETRY);
    }
  }

  drawHint() {
    return this.cornerA
      ? "Drawing Rectangle: click the opposite corner. Esc cancels."
      : "Drawing Rectangle: click the first corner.";
  }

  createFillGeometry() {
    return this.isValid() ? this.polygonGeometry(this.corners()) : undefined;
  }

  outlineLines() {
    return this.isValid() ? [{ positions: this.corners(), loop: true }] : [];
  }

  translateAnchor() {
    const r = this.bounds();
    return r && Cartesian3.fromRadians((r.west + r.east) / 2, (r.north + r.south) / 2, this.pointHeight);
  }

  markerSpecs() {
    const corners = this.corners();
    if (corners.length === 0) {
      return [];
    }
    if (this._mode !== ShapeMode.EDIT) {
      return [{ key: "c0", position: this.atPointHeight(this.cornerA), role: "corner" }];
    }
    return [
      ...corners.map((position, index) => ({ key: `c${index}`, position, role: "corner", index })),
      ...this.translateSpec(),
    ];
  }

  onMarkerDrag(spec, position) {
    if (spec.role !== "corner") {
      return;
    }
    const corners = this.corners();
    this.cornerA = corners[(spec.index + 2) % 4]; // the opposite corner stays put
    this.cornerB = position;
    this.invalidate(Dirty.GEOMETRY);
  }

  /** Shifts longitude and latitude, so the rectangle stays aligned with the grid. */
  translate(from, to) {
    const f = toCartographic(from);
    const t = toCartographic(to);
    const dLon = t.longitude - f.longitude;
    const r = this.bounds();
    const dLat = CesiumMath.clamp(t.latitude - f.latitude, -MAX_LATITUDE - r.south, MAX_LATITUDE - r.north);
    const shift = (p) => {
      const c = toCartographic(p, new Cartographic());
      return Cartesian3.fromRadians(
        CesiumMath.negativePiToPi(c.longitude + dLon),
        c.latitude + dLat,
        c.height,
      );
    };
    this.cornerA = shift(this.cornerA);
    this.cornerB = shift(this.cornerB);
    this.invalidate(Dirty.GEOMETRY);
  }
}

Shape.register(Rectangle);
