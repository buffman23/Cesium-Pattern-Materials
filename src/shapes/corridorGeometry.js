import {
  ArcType,
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  ComponentDatatype,
  Ellipsoid,
  EllipsoidTangentPlane,
  Geometry,
  GeometryAttribute,
  PrimitiveType,
} from "cesium";
import polygonClipping from "polygon-clipping";
import { sampleArc, toCartographic } from "./geodesy.js";
import { createPolygonGeometry } from "./liftedPolygon.js";

/**
 * Layout of a corridor made of cylinders: vertex i is a circle of radius rᵢ (geodesic) from
 * altitude minᵢ to maxᵢ, and each leg is the hull of two consecutive circles (straight tangent
 * sides, so the width tapers).
 *
 * The 2D work happens in a plane in which the arc type's lines are straight, so a straight
 * edge there is exactly a geodesic or a rhumb line:
 *  - GEODESIC: gnomonic projection (EllipsoidTangentPlane at the vertices' centroid);
 *  - RHUMB:    ellipsoidal Mercator.
 * In that plane: circle polygons (true geodesic circles, projected), convex hulls of
 * consecutive circles (the legs) and their union (the footprint, drawn on the ground). For the
 * volume, circle pieces and leg pieces cut only against their neighbours along the chain, so a
 * leg crossing another at a different altitude stays a separate volume above or below it.
 * Each piece has its own floor / ceiling:
 *  - circle i: minᵢ / maxᵢ;
 *  - leg i, "slope": interpolated between its two cylinders by how far the point is outside
 *    each (0 at circle i's edge, 1 at circle i+1's), so the slope meets both cylinders;
 *  - leg i, "step": the lower floor and the higher ceiling of its two cylinders.
 * The volume is the pieces' top and bottom surfaces (lifted, subdivided polygons), full walls
 * along each piece's outside edges, and step walls where neighbouring pieces meet at different
 * heights.
 *
 * Corridors must fit within a hemisphere around their centroid (gnomonic projection).
 */

const ellipsoid = Ellipsoid.WGS84;
const A = ellipsoid.maximumRadius;
const E = Math.sqrt(1 - (ellipsoid.minimumRadius / A) ** 2);
const MAX_MERCATOR_LAT = (89.5 * Math.PI) / 180;
const STEP_TOLERANCE = 0.5; // meters: smaller height differences get no step wall

// --- Projections ---------------------------------------------------------------------------

function gnomonicPlane(centers) {
  const plane = EllipsoidTangentPlane.fromPoints(centers, ellipsoid);
  const scratch = new Cartesian2();
  return {
    project(position) {
      const p = plane.projectPointOntoPlane(position, scratch);
      return p ? [p.x, p.y] : undefined;
    },
    unproject([x, y], height) {
      const surface = plane.projectPointOntoEllipsoid(new Cartesian2(x, y), new Cartesian3());
      const c = ellipsoid.cartesianToCartographic(surface, new Cartographic());
      return Cartesian3.fromRadians(c.longitude, c.latitude, height);
    },
  };
}

function mercatorPlane(centers) {
  const lon0 = toCartographic(centers[0]).longitude;
  const wrap = (lon) => {
    let d = lon - lon0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  };
  const scratch = new Cartographic();
  return {
    project(position) {
      const c = toCartographic(position, scratch);
      const lat = Math.max(Math.min(c.latitude, MAX_MERCATOR_LAT), -MAX_MERCATOR_LAT);
      const s = Math.sin(lat);
      return [A * wrap(c.longitude), A * (Math.atanh(s) - E * Math.atanh(E * s))];
    },
    unproject([x, y], height) {
      const t = Math.exp(-y / A);
      let lat = Math.PI / 2 - 2 * Math.atan(t);
      for (let i = 0; i < 8; i++) {
        const es = E * Math.sin(lat);
        lat = Math.PI / 2 - 2 * Math.atan(t * ((1 - es) / (1 + es)) ** (E / 2));
      }
      return Cartesian3.fromRadians(x / A + lon0, lat, height);
    },
  };
}

// --- 2D helpers ----------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Convex hull (counterclockwise, not closed) by the monotone chain. */
function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) {
    return pts;
  }
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

// Inside a counterclockwise convex ring (not closed), with a tolerance in plane units.
function insideConvex(ring, p, tolerance) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const length = dist(a, b) || 1;
    if (cross(a, b, p) / length < -tolerance) {
      return false;
    }
  }
  return true;
}

function segmentDistance(p, a, b) {
  const ab = sub(b, a);
  const lengthSq = ab[0] * ab[0] + ab[1] * ab[1];
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / lengthSq)) : 0;
  return Math.hypot(p[0] - (a[0] + ab[0] * t), p[1] - (a[1] + ab[1] * t));
}

// Distance from p to a convex ring: 0 inside.
function outsideDistance(ring, p) {
  if (insideConvex(ring, p, 0)) {
    return 0;
  }
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    best = Math.min(best, segmentDistance(p, ring[i], ring[(i + 1) % ring.length]));
  }
  return best;
}

const closed = (ring) => [...ring, ring[0]];
const open = (ring) => (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring);

// Inserts points so no edge of the (open) ring is longer than `step`; returns an open ring.
function densifyRing(ring, step) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    out.push(a);
    const pieces = Math.min(Math.ceil(dist(a, b) / step), 2048);
    for (let k = 1; k < pieces; k++) {
      out.push([a[0] + ((b[0] - a[0]) * k) / pieces, a[1] + ((b[1] - a[1]) * k) / pieces]);
    }
  }
  return out;
}

// --- Layout --------------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {Cartesian3[]} options.centers Vertex positions (heights ignored).
 * @param {number[]} options.radii Meters.
 * @param {number[]} options.minAltitudes Meters.
 * @param {number[]} options.maxAltitudes Meters.
 * @param {ArcType} options.arcType
 * @param {string} options.altitudeMode "slope" | "step".
 * @param {boolean} [options.interactive] Coarser, while drawing / dragging.
 */
export function corridorLayout({ centers, radii, minAltitudes, maxAltitudes, arcType, altitudeMode, interactive }) {
  const n = centers.length;
  const plane = arcType === ArcType.RHUMB ? mercatorPlane(centers) : gnomonicPlane(centers);
  const samples = interactive ? 24 : 64;

  // Circle rings in the plane (counterclockwise).
  const circles = centers.map((center, i) => {
    const points = sampleArc(center, radii[i], 0, 2 * Math.PI, samples, ArcType.GEODESIC, 0);
    points.pop();
    const ring = convexHull(points.map((p) => plane.project(p)).filter(Boolean));
    return { center: plane.project(center), ring };
  });
  const hulls = [];
  for (let i = 0; i + 1 < n; i++) {
    hulls.push(convexHull([...circles[i].ring, ...circles[i + 1].ring]));
  }
  const scale = Math.max(...hulls.flat().map((p) => Math.hypot(p[0], p[1])), 1);
  const tolerance = scale * 1e-7;
  // Ring subdivision. Straight edges in the plane are already exact geodesics / rhumb lines,
  // so points are only needed for the earth's curvature at altitude and for sloping heights:
  // 1/96 of the corridor's size (a wall between two points sags ~50 m at 5000 km across).
  // Denser rings cost a lot (edges, surfaces and Cesium all scale with the point count).
  const step = Math.max(scale / (interactive ? 48 : 96), 1);

  const asPolygon = (ring) => [closed(ring)];
  const footprint = polygonClipping.union(...hulls.map(asPolygon));

  // Pieces of the volume: the circles and the legs, each cut only against its neighbours along
  // the chain (so the joins don't overlap). Far-away parts are never cut against each other: a
  // leg that crosses another leg at a different altitude stays its own volume, above or below.
  const circlePieces = circles.map((c, i) =>
    i === 0 ? [asPolygon(c.ring)] : polygonClipping.difference(asPolygon(c.ring), asPolygon(circles[i - 1].ring)),
  );
  const legPieces = [];
  hulls.forEach((hull, i) => {
    const cuts = [asPolygon(circles[i].ring), asPolygon(circles[i + 1].ring)];
    if (i > 0 && legPieces[i - 1].length > 0) cuts.push(legPieces[i - 1]);
    legPieces.push(polygonClipping.difference(asPolygon(hull), ...cuts));
  });
  const pieces = [
    ...circlePieces.map((multi, index) => ({ kind: "circle", index, multi })),
    ...legPieces.map((multi, index) => ({ kind: "leg", index, multi })),
  ];
  pieces.forEach((piece, id) => {
    piece.id = id;
  });
  // Neighbours along the chain: circle i touches circles i±1 and legs i-1, i; leg i touches
  // circles i, i+1 and legs i±1.
  const neighbours = (piece) =>
    pieces.filter((o) =>
      piece.kind === "circle"
        ? (o.kind === "circle" && Math.abs(o.index - piece.index) === 1) ||
          (o.kind === "leg" && (o.index === piece.index || o.index === piece.index - 1))
        : (o.kind === "circle" && (o.index === piece.index || o.index === piece.index + 1)) ||
          (o.kind === "leg" && Math.abs(o.index - piece.index) === 1),
    );
  const inRing = (ring, [x, y]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  // Bounding boxes first: most points tested are far outside most pieces.
  for (const piece of pieces) {
    const outer = piece.multi.flatMap((polygon) => polygon[0]);
    piece.box = outer.length
      ? [
          Math.min(...outer.map((q) => q[0])),
          Math.min(...outer.map((q) => q[1])),
          Math.max(...outer.map((q) => q[0])),
          Math.max(...outer.map((q) => q[1])),
        ]
      : [Infinity, Infinity, -Infinity, -Infinity];
  }
  const pieceContains = (piece, p) => {
    const [x0, y0, x1, y1] = piece.box;
    if (p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) return false;
    return piece.multi.some((polygon) => inRing(polygon[0], p) && !polygon.slice(1).some((hole) => inRing(hole, p)));
  };

  // Heights of a piece at a plane point: { floor, ceil }.
  const stepMode = altitudeMode === "step";
  const pieceHeights = (piece, p) => {
    if (piece.kind === "circle") {
      return { floor: minAltitudes[piece.index], ceil: maxAltitudes[piece.index] };
    }
    const i = piece.index;
    if (stepMode) {
      return {
        floor: Math.min(minAltitudes[i], minAltitudes[i + 1]),
        ceil: Math.max(maxAltitudes[i], maxAltitudes[i + 1]),
      };
    }
    const d0 = outsideDistance(circles[i].ring, p);
    const d1 = outsideDistance(circles[i + 1].ring, p);
    const t = d0 + d1 > 0 ? d0 / (d0 + d1) : 0;
    return {
      floor: minAltitudes[i] + (minAltitudes[i + 1] - minAltitudes[i]) * t,
      ceil: maxAltitudes[i] + (maxAltitudes[i + 1] - maxAltitudes[i]) * t,
    };
  };

  const toPositions = (ring, height = 0) => densifyRing(open(ring), step).map((p) => plane.unproject(p, height));

  /** Footprint polygons on the ground: [{ outer, holes }] (Cartesian3, height 0). */
  const footprintPolygons = footprint.map((polygon) => ({
    outer: toPositions(polygon[0]),
    holes: polygon.slice(1).map((ring) => toPositions(ring)),
  }));

  // Walls and outlines, per piece edge. An edge with no neighbouring piece across it is outside:
  // a full wall from the piece's floor to its ceiling, outlined at both. An edge shared with a
  // neighbour only gets a wall for the height difference (a step), drawn once per edge.
  let edges;
  function pieceEdges() {
    if (edges) return edges;
    const quads = [];
    const lines = [];
    const offset = Math.max(scale * 1e-5, tolerance * 10);
    for (const piece of pieces) {
      const near = neighbours(piece);
      for (const polygon of piece.multi) {
        for (const ring of polygon) {
          const points = densifyRing(open(ring), step);
          // Per point: this piece's heights, and each (point, height) unprojected only once
          // (walls and outlines share them; unprojecting is the expensive part).
          const own = points.map((p) => pieceHeights(piece, p));
          const cache = new Map();
          const at = (k, height) => {
            const key = `${k}|${height}`;
            let position = cache.get(key);
            if (!position) {
              position = plane.unproject(points[k], height);
              cache.set(key, position);
            }
            return position;
          };
          let top = [];
          let bottom = [];
          const flush = () => {
            if (top.length > 1) lines.push(top, bottom);
            top = [];
            bottom = [];
          };
          for (let k = 0; k < points.length; k++) {
            const kb = (k + 1) % points.length;
            const a = points[k];
            const b = points[kb];
            const length = dist(a, b);
            if (!(length > 0)) continue;
            // A point just across the edge, on the side away from this piece.
            const nx = (-(b[1] - a[1]) / length) * offset;
            const ny = ((b[0] - a[0]) / length) * offset;
            const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            const q1 = [m[0] + nx, m[1] + ny];
            const across = pieceContains(piece, q1) ? [m[0] - nx, m[1] - ny] : q1;
            const other = near.find((o) => pieceContains(o, across));
            const ha = own[k];
            const hb = own[kb];
            if (!other) {
              quads.push([at(k, ha.floor), at(k, ha.ceil), at(kb, hb.floor), at(kb, hb.ceil)]);
              if (top.length === 0) {
                top.push(at(k, ha.ceil));
                bottom.push(at(k, ha.floor));
              }
              top.push(at(kb, hb.ceil));
              bottom.push(at(kb, hb.floor));
              continue;
            }
            flush();
            if (other.id < piece.id) continue; // the other piece draws this edge's step
            const oa = pieceHeights(other, a);
            const ob = pieceHeights(other, b);
            for (const key of ["ceil", "floor"]) {
              if (Math.abs(ha[key] - oa[key]) > STEP_TOLERANCE || Math.abs(hb[key] - ob[key]) > STEP_TOLERANCE) {
                quads.push([
                  at(k, Math.min(ha[key], oa[key])),
                  at(k, Math.max(ha[key], oa[key])),
                  at(kb, Math.min(hb[key], ob[key])),
                  at(kb, Math.max(hb[key], ob[key])),
                ]);
              }
            }
          }
          flush();
        }
      }
    }
    edges = { quads, lines };
    return edges;
  }

  /** Outline lines for the volume: each piece's outside edges at its ceiling and floor. */
  function volumeOutlines() {
    return pieceEdges().lines;
  }

  /** Created geometries of the volume: piece tops and bottoms, outer walls, step walls. */
  function volumeGeometries(granularity) {
    const geometries = [];
    for (const piece of pieces) {
      for (const polygon of piece.multi) {
        const outer = toPositions(polygon[0]);
        const holes = polygon.slice(1).map((ring) => toPositions(ring));
        if (outer.length < 3) continue;
        for (const key of ["ceil", "floor"]) {
          const geometry = createPolygonGeometry(outer, {
            holes,
            granularity,
            arcType: ArcType.GEODESIC, // the rings are densified already
            heightAt: (position) => {
              const p = plane.project(position);
              return p ? pieceHeights(piece, p)[key] : 0;
            },
          });
          if (geometry) geometries.push(geometry);
        }
      }
    }
    const walls = wallGeometry(pieceEdges().quads);
    if (walls) geometries.push(walls);
    return geometries;
  }

  /** Every footprint point (for bounding volumes and pattern origins). */
  const footprintPoints = () => footprintPolygons.flatMap((p) => [...p.outer, ...p.holes.flat()]);

  return { footprintPolygons, footprintPoints, volumeOutlines, volumeGeometries };
}

// Vertical quads [aBottom, aTop, bBottom, bTop] (Cartesian3) as one geometry (position,
// normal, st).
function wallGeometry(quads) {
  if (quads.length === 0) {
    return undefined;
  }
  const positions = new Float64Array(quads.length * 12);
  const normals = new Float32Array(quads.length * 12);
  const st = new Float32Array(quads.length * 8);
  const indices = new Uint32Array(quads.length * 6);
  const up = new Cartesian3();
  const along = new Cartesian3();
  const normal = new Cartesian3();
  quads.forEach((corners, q) => {
    ellipsoid.geodeticSurfaceNormal(corners[0], up);
    Cartesian3.subtract(corners[2], corners[0], along);
    Cartesian3.cross(along, up, normal);
    // Zero-width quads (the vertical seam of a step drawn at one point) have no direction:
    // any unit normal will do, and Cesium's normal compression requires one.
    if (Cartesian3.magnitudeSquared(normal) > 1e-12) {
      Cartesian3.normalize(normal, normal);
    } else {
      Cartesian3.clone(up, normal);
    }
    corners.forEach((c, k) => {
      positions.set([c.x, c.y, c.z], q * 12 + k * 3);
      normals.set([normal.x, normal.y, normal.z], q * 12 + k * 3);
    });
    st.set([0, 0, 0, 1, 1, 0, 1, 1], q * 8);
    const base = q * 4;
    indices.set([base, base + 2, base + 1, base + 1, base + 2, base + 3], q * 6);
  });
  return new Geometry({
    attributes: {
      position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }),
      normal: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: normals }),
      st: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st }),
    },
    indices,
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.fromVertices(positions),
  });
}
