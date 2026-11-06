import { CornerType, CorridorGeometry, MaterialAppearance } from "cesium";
import Shape, { Dirty, clonePositions } from "./Shape.js";
import VertexShape from "./VertexShape.js";
import {
  arrivalBearing,
  bearing,
  corridorOutline,
  crossTrackDistance,
  densify,
  destination,
  interpolate,
  lineLength,
  polygonGranularity,
} from "./geodesy.js";

const CORNER_NAMES = { [CornerType.ROUNDED]: "ROUNDED", [CornerType.MITERED]: "MITERED", [CornerType.BEVELED]: "BEVELED" };

/**
 * A band `width` meters wide along a centerline. The centerline is densified along the
 * shape's arcType (CorridorGeometry itself has no arcType), and that same dense centerline
 * builds both the fill (CorridorGeometry) and the outline (offset edges + caps), so they
 * match. Two primitives in all, however long the corridor.
 *
 * Edit markers: the centerline vertices plus a width marker beside the first segment. One
 * height for the whole corridor at altitude.
 */
export default class Corridor extends VertexShape {
  static type = "Corridor";
  static minVertices = 2;
  static singleHeight = true;

  static fields = [
    ...super.fields,
    {
      name: "width",
      label: "Width",
      type: "distance",
      min: 1,
      get: (s) => s.width,
      set: (s, v) => s.setWidth(v),
    },
    {
      name: "cornerType",
      label: "Corners",
      type: "enum",
      options: ["ROUNDED", "MITERED", "BEVELED"],
      get: (s) => CORNER_NAMES[s.cornerType],
      set: (s, v) => s.setCornerType(CornerType[v]),
    },
  ];

  /**
   * @param {object} [options] VertexShape options, plus:
   * @param {number} [options.width=1000] Meters.
   * @param {CornerType} [options.cornerType=CornerType.ROUNDED]
   */
  constructor(options = {}) {
    super(options);
    this.width = options.width ?? 1000;
    this.cornerType = options.cornerType ?? CornerType.ROUNDED;
    this._dense = undefined;
  }

  static stateFromJSON(json) {
    return {
      ...super.stateFromJSON(json),
      width: json.width,
      cornerType: CornerType[json.cornerType] ?? CornerType.ROUNDED,
    };
  }

  stateToJSON() {
    return { ...super.stateToJSON(), width: this.width, cornerType: CORNER_NAMES[this.cornerType] };
  }

  setWidth(width) {
    this.width = Math.max(width, 1);
    this.invalidate(Dirty.GEOMETRY);
  }

  setCornerType(cornerType) {
    this.cornerType = cornerType;
    this.invalidate(Dirty.GEOMETRY);
  }

  invalidate(flags) {
    this._dense = undefined;
    super.invalidate(flags);
  }

  // The densified centerline, shared by fill and outline in one rebuild.
  #centerline() {
    if (!this._dense) {
      const positions = this.drawPositions();
      const pieces = this.detail.lineSegments / this.detailFactor;
      const length = lineLength(positions, this.arcType);
      // Pieces no shorter than the half width: finer detail than that is lost in the corners.
      this._dense = densify(positions, this.arcType, Math.max(length / pieces, this.width / 2, 1));
    }
    return this._dense;
  }

  createFillGeometry() {
    const centerline = this.#centerline();
    if (centerline.length < 2 || !(this.width > 0)) {
      return undefined;
    }
    this._fillPositions = centerline;
    return new CorridorGeometry({
      positions: clonePositions(centerline), // CorridorGeometry modifies them in place

      width: this.width,
      cornerType: this.cornerType,
      vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
      granularity: polygonGranularity(centerline, this.detail, this.detailFactor),
      height: this.clampToGround ? 0 : this.height,
    });
  }

  outlineLines() {
    const centerline = this.#centerline();
    const loop = corridorOutline(centerline, this.width, this.arcType, this.cornerType);
    return loop.length > 2 ? [{ positions: loop, loop: true }] : [];
  }

  extraMarkerSpecs() {
    if (this.positions.length < 2) {
      return [];
    }
    const [a, b] = this.drawPositions();
    const middle = interpolate(a, b, 0.5, this.arcType);
    const heading = bearing(middle, b, this.arcType);
    const out = heading + Math.PI / 2;
    const position = destination(middle, out, this.width / 2, this.arcType);
    // axis: the direction the width changes in, at the marker (for the resize icon).
    const axis = this.width > 0 ? arrivalBearing(middle, position, this.arcType) : out;
    return [{ key: "width", position, role: "width", axis }];
  }

  onMarkerDrag(spec, position) {
    if (spec.role === "width") {
      const [a, b] = this.drawPositions();
      this.setWidth(2 * Math.abs(crossTrackDistance(position, a, b, this.arcType)));
      return;
    }
    super.onMarkerDrag(spec, position);
  }
}

Shape.register(Corridor);
