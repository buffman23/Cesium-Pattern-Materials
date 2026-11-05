import { ArcType, Cartesian3, Math as CesiumMath } from "cesium";
import Shape, { Dirty, fromDegrees, toDegrees } from "./Shape.js";
import ShapeMode from "./ShapeMode.js";
import { destination, distance, heightOf, sampleArc, withHeight } from "./geodesy.js";

const RADIUS_BEARINGS = [0, 90, 180, 270].map(CesiumMath.toRadians);

/**
 * All points `radius` meters (geodesic distance) from `center`. Drawn by clicking the
 * center, then a point on the circumference.
 *
 * Edit markers: the center (moves the circle) and four radius markers at north, east, south
 * and west. A circle is defined by distance alone, so arcType doesn't change it.
 */
export default class Circle extends Shape {
  static type = "Circle";

  /**
   * @param {object} [options] Shape options, plus:
   * @param {Cartesian3} [options.center]
   * @param {number} [options.radius=0] Meters.
   */
  constructor(options = {}) {
    super(options);
    this.center = options.center && Cartesian3.clone(options.center);
    this.radius = options.radius ?? 0;
  }

  static stateFromJSON(json) {
    return { center: json.center && fromDegrees(json.center), radius: json.radius };
  }

  stateToJSON() {
    return { center: this.center && toDegrees(this.center), radius: this.radius };
  }

  setCenter(center) {
    this.center = Cartesian3.clone(center);
    this.invalidate(Dirty.GEOMETRY);
  }

  setRadius(radius) {
    this.radius = Math.max(radius, 0);
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
    return Boolean(this.center) && this.radius > 0;
  }

  onDrawClick(position) {
    if (!this.center) {
      this.center = position;
      this.invalidate(Dirty.GEOMETRY);
      return "continue";
    }
    this.radius = distance(this.center, position);
    this.invalidate(Dirty.GEOMETRY);
    return "done";
  }

  onDrawMove(position) {
    if (this.center) {
      this.radius = distance(this.center, position);
      this.invalidate(Dirty.GEOMETRY);
    }
  }

  drawHint() {
    return this.center
      ? "Drawing Circle: click to set the radius. Esc cancels."
      : "Drawing Circle: click to place the center.";
  }

  /** Boundary points, at the shape's point height. */
  boundary() {
    if (!this.isValid()) {
      return [];
    }
    const segments = Math.max(16, Math.round(this.detail.arcSegments / this.detailFactor));
    const points = sampleArc(
      this.center,
      this.radius,
      0,
      CesiumMath.TWO_PI,
      segments,
      ArcType.GEODESIC,
      this.pointHeight,
    );
    points.pop(); // the last point repeats the first
    return points;
  }

  createFillGeometry() {
    return this.polygonGeometry(this.boundary());
  }

  outlineLines() {
    const boundary = this.boundary();
    return boundary.length > 2 ? [{ positions: boundary, loop: true }] : [];
  }

  /**
   * True once the radius is more than halfway to the center's antipode: the circle then
   * encloses more than a hemisphere around `center`, and what shows is the smaller circle
   * around the antipode.
   */
  get flipped() {
    if (!this.isValid()) {
      return false;
    }
    // Each circle point is `radius` from the center and the rest of the way from the
    // antipode; compare chord lengths at the four radius bearings (averaged, as distances to
    // the antipode vary with bearing on the ellipsoid).
    const center = withHeight(this.center, 0);
    const antipode = Cartesian3.negate(center, new Cartesian3());
    let toCenter = 0;
    let toAntipode = 0;
    for (const b of RADIUS_BEARINGS) {
      const p = destination(this.center, b, this.radius, ArcType.GEODESIC, 0);
      toCenter += Cartesian3.distance(p, center);
      toAntipode += Cartesian3.distance(p, antipode);
    }
    return toCenter > toAntipode;
  }

  /** The center as seen: `center`, or its antipode once {@link Circle#flipped}. */
  visualCenter() {
    if (!this.center) {
      return undefined;
    }
    const center = this.atPointHeight(this.center);
    if (!this.flipped) {
      return center;
    }
    const antipode = Cartesian3.negate(withHeight(this.center, 0), new Cartesian3());
    return this.atPointHeight(antipode);
  }

  translateAnchor() {
    return this.visualCenter();
  }

  markerSpecs() {
    if (!this.center) {
      return [];
    }
    // The center marker (translate marker in EDIT_MODE) sits where the circle appears to be
    // centered, so it moves to the antipode once the circle flips.
    const center = this.visualCenter();
    const specs = [];
    // The center doubles as the translate marker; while drawing it's just a plain marker.
    if (this._mode === ShapeMode.EDIT && this.markerOptions.translatable) {
      specs.push(...this.translateSpec(center));
    } else {
      specs.push({ key: "center", position: center, role: "center", flipped: this.flipped });
    }
    if (this.radius > 0 && this._mode === ShapeMode.EDIT) {
      for (const [i, b] of RADIUS_BEARINGS.entries()) {
        specs.push({
          key: `r${i}`,
          position: sampleArc(this.center, this.radius, b, b, 1, ArcType.GEODESIC, this.pointHeight)[0],
          role: "radius",
        });
      }
    }
    return specs;
  }

  onMarkerDrag(spec, position) {
    if (spec.role === "radius") {
      this.setRadius(distance(this.center, position));
    } else if (spec.role === "center") {
      // A flipped circle's center marker is at the antipode: move the real center opposite.
      this.setCenter(
        spec.flipped
          ? withHeight(Cartesian3.negate(withHeight(position, 0), new Cartesian3()), heightOf(position))
          : position,
      );
    }
  }
}

Shape.register(Circle);
