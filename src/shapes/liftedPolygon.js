import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  ComponentDatatype,
  EllipsoidTangentPlane,
  GeometryAttribute,
  PolygonGeometry,
  PolygonHierarchy,
  PolygonPipeline,
  VertexFormat,
} from "cesium";
import { ellipsoid, heightOf, withHeight } from "./geodesy.js";

// Polygon fills at altitude that Cesium's PolygonGeometry can't build directly.
//
// 1. Varying heights. With perPositionHeight, PolygonGeometry triangulates the vertices as
//    they are, with no subdivision: edges become straight chords that ignore the arc type, and
//    the middle sags below the curved ground (about D² / 8R, ~20 km across 1000 km). Instead,
//    the polygon is built the subdivided way at height 0 and every vertex is raised by a
//    height interpolated from the boundary vertices.
//
// 2. Wide polygons (bounding rectangle 180° or more across, e.g. over a pole). Cesium 1.122's
//    PolygonGeometry throws "normalized result is not a number" computing their texture
//    coordinates (computeAttributes passes an array to a projection that expects one
//    position). They're built with positions only, and normals and texture coordinates are
//    added here.

const scratchPosition = new Cartesian3();
const scratchNormal = new Cartesian3();
const scratchPlanar = new Cartesian2();
const scratchCartographic = new Cartographic();

/** True if PolygonGeometry would take its broken wide-polygon path for this boundary. */
export function isWidePolygon(boundary, arcType) {
  const r = PolygonGeometry.computeRectangleFromPositions(boundary, ellipsoid, arcType);
  return r.width >= Math.PI || r.height >= Math.PI;
}

/**
 * Created Geometry (position, normal, st) for a polygon at altitude.
 *
 * @param {Cartesian3[]} boundary Vertices with their heights.
 * @param {object} options
 * @param {number} options.granularity Radians.
 * @param {ArcType} options.arcType
 * @param {number} [options.height] One height for the whole polygon; omitted = interpolate
 *   the vertices' own heights.
 * @param {Cartesian3[][]} [options.holes] Hole rings.
 * @param {function} [options.heightAt] (surfacePosition) => height, for every vertex of the
 *   subdivided polygon; overrides `height` and the interpolation.
 * @returns {Geometry|undefined}
 */
export function createPolygonGeometry(boundary, { granularity, arcType, height, holes = [], heightAt: customHeightAt }) {
  const surface = (ring) => ring.map((p) => withHeight(p, 0));
  const geometry = PolygonGeometry.createGeometry(
    new PolygonGeometry({
      polygonHierarchy: new PolygonHierarchy(
        surface(boundary),
        holes.map((hole) => new PolygonHierarchy(surface(hole))),
      ),
      height: 0,
      granularity,
      arcType,
      vertexFormat: VertexFormat.POSITION_ONLY,
    }),
  );
  if (!geometry) {
    return undefined;
  }
  removeDuplicateTriangles(geometry);
  const values = geometry.attributes.position.values;
  const heightAt =
    customHeightAt ?? (height === undefined ? heightInterpolator(boundary) : () => height);
  const normals = new Float32Array(values.length);
  const st = textureCoordinates(values, boundary);

  for (let i = 0; i < values.length; i += 3) {
    const position = Cartesian3.fromArray(values, i, scratchPosition);
    const normal = ellipsoid.geodeticSurfaceNormal(position, scratchNormal);
    const h = heightAt(position);
    values[i] += normal.x * h;
    values[i + 1] += normal.y * h;
    values[i + 2] += normal.z * h;
    normals[i] = normal.x;
    normals[i + 1] = normal.y;
    normals[i + 2] = normal.z;
  }
  geometry.attributes.normal = new GeometryAttribute({
    componentDatatype: ComponentDatatype.FLOAT,
    componentsPerAttribute: 3,
    values: normals,
  });
  geometry.attributes.st = new GeometryAttribute({
    componentDatatype: ComponentDatatype.FLOAT,
    componentsPerAttribute: 2,
    values: st,
  });
  geometry.boundingSphere = BoundingSphere.fromVertices(values);
  return geometry;
}

// Cesium 1.122's subdivided PolygonGeometry emits every triangle twice (with separate vertex
// copies) once a polygon is large (~5000 km across): harmless on the ground, but at altitude
// it doubles a translucent fill's opacity. Welds vertices by position and drops repeated
// triangles. Unused vertices are left in place.
function removeDuplicateTriangles(geometry) {
  const values = geometry.attributes.position.values;
  const count = values.length / 3;
  const canonical = new Uint32Array(count);
  const byPosition = new Map();
  for (let i = 0; i < count; i++) {
    // Millimeter keys: duplicated vertices are bit-identical copies.
    const key = `${Math.round(values[3 * i] * 1000)},${Math.round(values[3 * i + 1] * 1000)},${Math.round(values[3 * i + 2] * 1000)}`;
    let first = byPosition.get(key);
    if (first === undefined) {
      first = i;
      byPosition.set(key, i);
    }
    canonical[i] = first;
  }
  if (byPosition.size === count) {
    return; // no duplicated vertices, so no duplicated triangles
  }
  const indices = geometry.indices;
  const kept = [];
  const seen = new Set();
  // Numeric keys stay exact below 2^53, i.e. up to ~200k vertices; strings beyond that.
  const numericKeys = count < 200000;
  for (let t = 0; t < indices.length; t += 3) {
    const a = canonical[indices[t]];
    const b = canonical[indices[t + 1]];
    const c = canonical[indices[t + 2]];
    // Key from the sorted corners; the output keeps the original winding.
    const lo = Math.min(a, b, c);
    const hi = Math.max(a, b, c);
    const mid = a + b + c - lo - hi;
    const key = numericKeys ? (lo * count + mid) * count + hi : `${lo},${mid},${hi}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(indices[t], indices[t + 1], indices[t + 2]);
  }
  geometry.indices = count > 65535 ? new Uint32Array(kept) : new Uint16Array(kept);
}

// Texture coordinates in [0, 1] over the polygon: longitude / latitude for polygons that
// cross the equator, a polar stereographic projection otherwise (like Cesium's own).
function textureCoordinates(values, boundary) {
  const crossesEquator =
    boundary.some((p) => p.z > 0) && boundary.some((p) => p.z < 0);
  const south = boundary.reduce((sum, p) => sum + p.z, 0) < 0;
  const raw = new Float64Array((values.length / 3) * 2);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0, j = 0; i < values.length; i += 3, j += 2) {
    const c = ellipsoid.cartesianToCartographic(
      Cartesian3.fromArray(values, i, scratchPosition),
      scratchCartographic,
    );
    let x;
    let y;
    if (!c) {
      x = 0;
      y = 0;
    } else if (crossesEquator) {
      x = c.longitude;
      y = c.latitude;
    } else {
      const k = Math.tan((Math.PI / 2 - Math.abs(c.latitude)) / 2);
      x = k * Math.cos(c.longitude);
      y = (south ? -1 : 1) * k * Math.sin(c.longitude);
    }
    raw[j] = x;
    raw[j + 1] = y;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const width = maxX - minX || 1;
  const height = maxY - minY || 1;
  const st = new Float32Array(raw.length);
  for (let j = 0; j < raw.length; j += 2) {
    st[j] = Math.min(Math.max((raw[j] - minX) / width, 0), 1);
    st[j + 1] = Math.min(Math.max((raw[j + 1] - minY) / height, 0), 1);
  }
  return st;
}

// Height at a surface point: barycentric in the triangle of the vertex triangulation (in a
// tangent plane) containing it; points just outside every triangle (edges curve slightly in
// the plane) use the nearest one, clamped. Falls back to the average height.
function heightInterpolator(boundary) {
  const heights = boundary.map(heightOf);
  const average = heights.reduce((sum, h) => sum + h, 0) / heights.length;
  const plane = EllipsoidTangentPlane.fromPoints(boundary, ellipsoid);
  const planar = plane.projectPointsOntoPlane(boundary);
  if (planar.length !== boundary.length) {
    return () => average; // some vertices are beyond the plane's horizon
  }
  const triangles = PolygonPipeline.triangulate(planar, []);
  return (position) => {
    const q = plane.projectPointOntoPlane(position, scratchPlanar);
    return (q && interpolateHeight(q, planar, triangles, heights)) ?? average;
  };
}

function interpolateHeight(q, planar, triangles, heights) {
  let best;
  let bestMin = -Infinity;
  for (let t = 0; t < triangles.length; t += 3) {
    const ia = triangles[t];
    const ib = triangles[t + 1];
    const ic = triangles[t + 2];
    const a = planar[ia];
    const b = planar[ib];
    const c = planar[ic];
    const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(det) < 1e-12) {
      continue;
    }
    const wa = ((b.y - c.y) * (q.x - c.x) + (c.x - b.x) * (q.y - c.y)) / det;
    const wb = ((c.y - a.y) * (q.x - c.x) + (a.x - c.x) * (q.y - c.y)) / det;
    const wc = 1 - wa - wb;
    const min = Math.min(wa, wb, wc);
    if (min > bestMin) {
      bestMin = min;
      best = [ia, ib, ic, wa, wb, wc];
      if (min >= 0) {
        break;
      }
    }
  }
  if (!best) {
    return undefined;
  }
  const [ia, ib, ic] = best;
  let [, , , wa, wb, wc] = best;
  if (bestMin < 0) {
    wa = Math.max(wa, 0);
    wb = Math.max(wb, 0);
    wc = Math.max(wc, 0);
    const sum = wa + wb + wc || 1;
    wa /= sum;
    wb /= sum;
    wc /= sum;
  }
  return wa * heights[ia] + wb * heights[ib] + wc * heights[ic];
}
