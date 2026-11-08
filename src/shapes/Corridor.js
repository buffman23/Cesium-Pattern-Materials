import { ArcType, Cartesian2, Cartesian3 } from "cesium";
import Shape, { Dirty, fieldPosition, fromDegrees } from "./Shape.js";
import ShapeMode from "./ShapeMode.js";
import VertexShape from "./VertexShape.js";
import { ROTATE_COLOR, WIDTH_COLOR, coloredMarkerImage } from "./Markers.js";
import {
  arrivalBearing,
  bearing,
  centroid,
  destination,
  distance,
  polygonGranularity,
  withHeight,
} from "./geodesy.js";
import { corridorLayout } from "./corridorGeometry.js";

/** How the floor and ceiling run between two cylinders (see Corridor). */
export const AltitudeMode = Object.freeze({ SLOPE: "slope", STEP: "step" });

const HALF_PI = Math.PI / 2;
const TOP_OFFSET = new Cartesian2(0, -7); // keeps the top and bottom markers apart from above
const BOTTOM_OFFSET = new Cartesian2(0, 7);

/**
 * A chain of cylinders: every vertex has its own radius (meters, geodesic) and min / max
 * altitude, and each leg joins two consecutive cylinders with straight tangent sides, so the
 * width tapers from one radius to the next. Edges follow the arc type.
 *
 * Between two cylinders the floor and ceiling either slope linearly from one cylinder's
 * values to the next (AltitudeMode.SLOPE), or stay at the lower floor and the higher ceiling
 * of the two (AltitudeMode.STEP), so they change in steps at the cylinders.
 *
 * Clamped to the ground, only the footprint (all circles and their tangent sides) is drawn;
 * otherwise the volume between the floors and ceilings. See corridorGeometry.js.
 *
 * Markers per vertex: the vertex (white; moves it, shift+drag raises the whole cylinder), a
 * yellow radius square on its circle and, at altitude, orange top and bottom squares dragged
 * up / down for the max and min altitude. With shift, a radius square scales every radius
 * and an altitude square every max (or min) altitude, by the same factor. New vertices copy
 * the previous vertex's radius and altitudes.
 */
export default class Corridor extends VertexShape {
  static type = "Corridor";
  static minVertices = 2;
  static singleHeight = true;

  static defaultMarkerOptions = {
    ...VertexShape.defaultMarkerOptions,
    roleStyles: {
      radius: { image: coloredMarkerImage(WIDTH_COLOR), width: 12, height: 12, align: false },
      altitude: { image: coloredMarkerImage(ROTATE_COLOR), width: 12, height: 12, align: false },
    },
  };

  static fields = [
    ...super.fields.filter((f) => f.name !== "positions" && f.name !== "height"),
    {
      name: "vertices",
      label: "Vertices",
      type: "table",
      min: 2,
      columns: [
        { name: "lon", label: "Lon °", type: "longitude" },
        { name: "lat", label: "Lat °", type: "latitude" },
        { name: "radius", label: "Radius m", type: "distance", min: 1 },
        { name: "minAltitude", label: "Min alt m", type: "distance", min: 0 },
        { name: "maxAltitude", label: "Max alt m", type: "distance", min: 0 },
      ],
      validate: (rows) => {
        rows.forEach((row, i) => {
          if (row.maxAltitude < row.minAltitude) {
            throw new Error(`Vertex ${i + 1}: the max altitude must be at least the min altitude.`);
          }
        });
        return rows;
      },
      get: (s) => s.getVertices(),
      set: (s, v) => s.setVertices(v),
    },
    {
      name: "altitudeMode",
      label: "Between vertices",
      type: "enum",
      options: [AltitudeMode.SLOPE, AltitudeMode.STEP],
      get: (s) => s.altitudeMode,
      set: (s, v) => s.setAltitudeMode(v),
    },
  ];

  /**
   * @param {object} [options] VertexShape options, plus:
   * @param {object[]} [options.vertices] [{ lon, lat, radius, minAltitude, maxAltitude }]
   *   (degrees, meters); takes precedence over `positions`.
   * @param {number} [options.radius=1000] Meters, for vertices without their own.
   * @param {number} [options.minAltitude=0] Meters.
   * @param {number} [options.maxAltitude=3000] Meters.
   * @param {string} [options.altitudeMode=AltitudeMode.SLOPE]
   * @param {number} [options.width] Old option: radius = width / 2.
   */
  constructor(options = {}) {
    super(options);
    const minAltitude = Math.max(options.minAltitude ?? 0, 0);
    this.vertexDefaults = {
      radius: Math.max(options.radius ?? (options.width !== undefined ? options.width / 2 : 1000), 1),
      minAltitude,
      maxAltitude: Math.max(options.maxAltitude ?? 3000, minAltitude),
    };
    this.altitudeMode = options.altitudeMode === AltitudeMode.STEP ? AltitudeMode.STEP : AltitudeMode.SLOPE;
    this.radii = [];
    this.minAltitudes = [];
    this.maxAltitudes = [];
    this._layout = undefined;
    if (options.vertices) {
      this.#applyRows(options.vertices);
    } else {
      this.#syncArrays();
    }
  }

  static stateFromJSON(json) {
    if (json.vertices) {
      return { vertices: json.vertices, altitudeMode: json.altitudeMode };
    }
    // Saved before corridors had cylinders: { positions, width }.
    return { positions: (json.positions ?? []).map(fromDegrees), width: json.width };
  }

  stateToJSON() {
    return { vertices: this.getVertices(), altitudeMode: this.altitudeMode };
  }

  // --- Per-vertex values -------------------------------------------------------------------

  // Keeps radii / altitudes as long as positions: new entries copy the last vertex (or take
  // the defaults), extra ones are dropped.
  #syncArrays() {
    const n = this.positions.length;
    for (const [key, name] of [["radii", "radius"], ["minAltitudes", "minAltitude"], ["maxAltitudes", "maxAltitude"]]) {
      const values = this[key];
      while (values.length < n) {
        values.push(values.length > 0 ? values[values.length - 1] : this.vertexDefaults[name]);
      }
      values.length = n;
    }
  }

  #applyRows(rows) {
    this.positions = rows.map((r) => Cartesian3.fromDegrees(r.lon, r.lat, 0));
    this.radii = rows.map((r) => Math.max(r.radius ?? this.vertexDefaults.radius, 1));
    this.minAltitudes = rows.map((r) => Math.max(r.minAltitude ?? this.vertexDefaults.minAltitude, 0));
    this.maxAltitudes = rows.map((r, i) => Math.max(r.maxAltitude ?? this.vertexDefaults.maxAltitude, this.minAltitudes[i]));
  }

  /** [{ lon, lat, radius, minAltitude, maxAltitude }] (degrees, meters). */
  getVertices() {
    return this.positions.map((p, i) => {
      const [lon, lat] = fieldPosition(p);
      return { lon, lat, radius: this.radii[i], minAltitude: this.minAltitudes[i], maxAltitude: this.maxAltitudes[i] };
    });
  }

  setVertices(rows) {
    this.#applyRows(rows);
    this.invalidate(Dirty.GEOMETRY);
  }

  setVertexRadius(index, radius) {
    this.radii[index] = Math.max(radius, 1);
    this.invalidate(Dirty.GEOMETRY);
  }

  /** Min and max altitude of a vertex's cylinder (meters; max is kept >= min, both >= 0). */
  setVertexAltitudes(index, minAltitude, maxAltitude) {
    const min = Math.max(minAltitude, 0);
    this.minAltitudes[index] = min;
    this.maxAltitudes[index] = Math.max(maxAltitude, min);
    this.invalidate(Dirty.GEOMETRY);
  }

  setAltitudeMode(mode) {
    this.altitudeMode = mode === AltitudeMode.STEP ? AltitudeMode.STEP : AltitudeMode.SLOPE;
    this.invalidate(Dirty.GEOMETRY);
  }

  /** Multiplies every vertex's radius by `factor` (each stays at least 1 m). */
  scaleRadii(factor) {
    if (!(factor > 0)) {
      return;
    }
    this.radii = this.radii.map((r) => Math.max(r * factor, 1));
    this.invalidate(Dirty.GEOMETRY);
  }

  /**
   * Multiplies every max ("max") or every min ("min") altitude by `factor`. Each vertex keeps
   * max >= min: maxes stop at their own min, mins at their own max (and at 0).
   */
  scaleAltitudes(which, factor) {
    if (!(factor >= 0)) {
      return;
    }
    this.#changeAltitudes(which, (h) => h * factor);
  }

  /** Moves every max ("max") or every min ("min") altitude by `delta` meters (same limits). */
  offsetAltitudes(which, delta) {
    this.#changeAltitudes(which, (h) => h + delta);
  }

  #changeAltitudes(which, change) {
    for (let i = 0; i < this.positions.length; i++) {
      if (which === "max") {
        this.maxAltitudes[i] = Math.max(change(this.maxAltitudes[i]), this.minAltitudes[i]);
      } else {
        this.minAltitudes[i] = Math.min(Math.max(change(this.minAltitudes[i]), 0), this.maxAltitudes[i]);
      }
    }
    this.invalidate(Dirty.GEOMETRY);
  }

  // VertexShape changes positions in these; keep the values in step.
  setPositions(positions) {
    super.setPositions(positions);
    this.#syncArrays();
  }

  onDrawClick(position) {
    const result = super.onDrawClick(withHeight(position, 0));
    this.#syncArrays();
    return result;
  }

  onDrawMove(position) {
    super.onDrawMove(withHeight(position, 0));
  }

  removeVertex(index) {
    const removed = super.removeVertex(index);
    if (removed) {
      this.radii.splice(index, 1);
      this.minAltitudes.splice(index, 1);
      this.maxAltitudes.splice(index, 1);
    }
    return removed;
  }

  insertVertex(index, position) {
    const from = Math.max(Math.min(index - 1, this.positions.length - 1), 0);
    super.insertVertex(index, withHeight(position, 0));
    if (this.radii.length > 0) {
      this.radii.splice(index, 0, this.radii[from]);
      this.minAltitudes.splice(index, 0, this.minAltitudes[from]);
      this.maxAltitudes.splice(index, 0, this.maxAltitudes[from]);
    }
    this.#syncArrays();
  }

  // Vertices are positions on the ground; the cylinders give the altitudes.
  get pointHeight() {
    return 0;
  }

  setHeight() {
    // No shape-wide height: each cylinder has its own altitudes.
  }

  // --- Geometry ----------------------------------------------------------------------------

  invalidate(flags) {
    this._layout = undefined;
    super.invalidate(flags);
  }

  // The layout, shared by fill, outline and markers within one rebuild.
  #layout() {
    if (this._layout === undefined) {
      const centers = this.drawPositions().map((p) => withHeight(p, 0));
      const n = centers.length;
      const extend = (values) => Array.from({ length: n }, (_, i) => values[Math.min(i, values.length - 1)]);
      this._layout =
        n >= 2 && this.radii.length > 0
          ? corridorLayout({
              centers,
              radii: extend(this.radii),
              minAltitudes: extend(this.minAltitudes),
              maxAltitudes: extend(this.maxAltitudes),
              arcType: this.arcType,
              altitudeMode: this.altitudeMode,
              interactive: this.interactive,
            })
          : null;
    }
    return this._layout;
  }

  createFillGeometry() {
    const layout = this.#layout();
    if (!layout) {
      return undefined;
    }
    let geometries;
    if (this.clampToGround) {
      geometries = layout.footprintPolygons.map((polygon) =>
        // The rings are densified in the arc type's plane already: plain geodesic edges.
        this.polygonGeometry(polygon.outer, { holes: polygon.holes, arcType: ArcType.GEODESIC }),
      );
    }
    this._fillPositions = layout.footprintPoints();
    if (!this.clampToGround) {
      geometries = layout.volumeGeometries(polygonGranularity(this._fillPositions, this.detail, this.detailFactor));
    }
    return geometries;
  }

  outlineLines() {
    const layout = this.#layout();
    if (!layout) {
      return [];
    }
    if (this.clampToGround) {
      return layout.footprintPolygons.flatMap((polygon) =>
        [polygon.outer, ...polygon.holes].map((ring) => ({ positions: ring, loop: true, arcType: ArcType.GEODESIC })),
      );
    }
    // Top and bottom edges of the volume (already closed).
    return layout.volumeOutlines().map((positions) => ({ positions, loop: false, arcType: ArcType.GEODESIC }));
  }

  // --- Markers -----------------------------------------------------------------------------

  // Direction of travel at a vertex (bearing): along the path, averaged at interior vertices.
  #direction(i) {
    const p = this.positions;
    if (p.length < 2) {
      return 0;
    }
    if (i === 0) {
      return bearing(p[0], p[1], this.arcType);
    }
    if (i === p.length - 1) {
      return arrivalBearing(p[i - 1], p[i], this.arcType);
    }
    const a = arrivalBearing(p[i - 1], p[i], this.arcType);
    const b = bearing(p[i], p[i + 1], this.arcType);
    return Math.atan2(Math.sin(a) + Math.sin(b), Math.cos(a) + Math.cos(b));
  }

  #midHeight(i) {
    return this.clampToGround ? 0 : (this.minAltitudes[i] + this.maxAltitudes[i]) / 2;
  }

  markerSpecs() {
    const o = this.markerOptions;
    const editing = this._mode === ShapeMode.EDIT;
    const canDelete = o.deletable && editing && this.positions.length > this.constructor.minVertices;
    const specs = [];
    this.positions.forEach((p, i) => {
      const mid = this.#midHeight(i);
      const center = withHeight(p, mid);
      specs.push({
        key: `v${i}`,
        position: center,
        role: "vertex",
        index: i,
        deletable: canDelete,
        label: o.numbered ? i + 1 : undefined,
      });
      if (!editing) {
        return;
      }
      const direction = this.#direction(i);
      const radius = this.radii[i];
      const side = destination(p, direction - HALF_PI, radius, ArcType.GEODESIC, mid);
      // shiftVertical: false - with shift this marker still drags sideways (and scales every
      // radius), instead of the usual shift+drag height change.
      specs.push({
        key: `r${i}`,
        position: side,
        role: "radius",
        index: i,
        axis: arrivalBearing(center, side),
        shiftVertical: false,
      });
      if (!this.clampToGround) {
        // On the circle opposite the radius marker, at the ceiling and the floor.
        const top = destination(p, direction + HALF_PI, radius, ArcType.GEODESIC, this.maxAltitudes[i]);
        const bottom = destination(p, direction + HALF_PI, radius, ArcType.GEODESIC, this.minAltitudes[i]);
        const vertical = { role: "altitude", index: i, vertical: true, axisUp: true };
        specs.push({ key: `t${i}`, position: top, which: "max", pixelOffset: TOP_OFFSET, ...vertical });
        specs.push({ key: `b${i}`, position: bottom, which: "min", pixelOffset: BOTTOM_OFFSET, ...vertical });
      }
    });
    specs.push(...this.translateSpec());
    return specs;
  }

  translateAnchor() {
    const anchor = centroid(this.positions);
    if (!anchor) {
      return undefined;
    }
    const mids = this.positions.map((_, i) => this.#midHeight(i));
    return withHeight(anchor, mids.reduce((sum, h) => sum + h, 0) / mids.length);
  }

  onMarkerDrag(spec, position, { shift = false } = {}) {
    if (spec.role === "vertex") {
      this.setVertex(spec.index, withHeight(position, 0));
    } else if (spec.role === "radius") {
      const radius = distance(this.positions[spec.index], position);
      if (shift) {
        // Every radius by the factor that takes this one to the cursor.
        this.scaleRadii(Math.max(radius, 1) / this.radii[spec.index]);
      } else {
        this.setVertexRadius(spec.index, radius);
      }
    }
  }

  markerHeight(spec) {
    if (spec.role === "altitude") {
      return spec.which === "max" ? this.maxAltitudes[spec.index] : this.minAltitudes[spec.index];
    }
    if (spec.role === "translate") {
      return this.translateAnchor()
        ? this.positions.reduce((sum, _, i) => sum + this.#midHeight(i), 0) / this.positions.length
        : 0;
    }
    return this.#midHeight(spec.index ?? 0);
  }

  /**
   * Vertical drags: altitude markers set min / max (with shift: every min or every max, by
   * the same factor); shift+drag on others raises cylinders.
   */
  onMarkerHeight(spec, height, { shift = false } = {}) {
    if (spec.role === "altitude") {
      const i = spec.index;
      if (shift) {
        const values = spec.which === "max" ? this.maxAltitudes : this.minAltitudes;
        const current = values[i];
        // From 0 there's no factor: move them all by the same amount instead.
        if (current > 0) {
          this.scaleAltitudes(spec.which, Math.max(height, 0) / current);
        } else {
          this.offsetAltitudes(spec.which, height - current);
        }
        return;
      }
      if (spec.which === "max") {
        this.setVertexAltitudes(i, this.minAltitudes[i], Math.max(height, this.minAltitudes[i]));
      } else {
        this.setVertexAltitudes(i, Math.min(height, this.maxAltitudes[i]), this.maxAltitudes[i]);
      }
      return;
    }
    const delta = height - this.markerHeight(spec);
    const indices = spec.role === "translate" ? this.positions.map((_, i) => i) : [spec.index];
    // Never below the ground: limit the move by the lowest floor involved.
    const lowest = Math.min(...indices.map((i) => this.minAltitudes[i]));
    const move = Math.max(delta, -lowest);
    for (const i of indices) {
      this.minAltitudes[i] += move;
      this.maxAltitudes[i] += move;
    }
    this.invalidate(Dirty.GEOMETRY);
  }
}

Shape.register(Corridor);
