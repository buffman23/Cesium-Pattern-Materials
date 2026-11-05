import {
  ArcType,
  BoundingSphere,
  Cartesian3,
  Cartographic,
  Math as CesiumMath,
  CornerType,
  Ellipsoid,
  EllipsoidGeodesic,
  EllipsoidRhumbLine,
  Matrix3,
  Quaternion,
} from "cesium";

// Geodesy helpers for shapes, on the WGS84 ellipsoid. Every function takes an ArcType:
// GEODESIC (shortest path) or RHUMB (constant heading). Bearings are radians clockwise from
// north; distances are meters along the ellipsoid surface. Heights are carried through
// unchanged unless stated otherwise.

export const ellipsoid = Ellipsoid.WGS84;
const TWO_PI = CesiumMath.TWO_PI;

const scratchA = new Cartographic();
const scratchB = new Cartographic();

export function toCartographic(position, result = new Cartographic()) {
  return ellipsoid.cartesianToCartographic(position, result);
}

/** Height of a position above the ellipsoid, meters. */
export function heightOf(position) {
  return toCartographic(position, scratchA).height;
}

/** The same position at another height above the ellipsoid. */
export function withHeight(position, height, result) {
  const c = toCartographic(position, scratchA);
  return Cartesian3.fromRadians(c.longitude, c.latitude, height, ellipsoid, result);
}

function isSamePoint(a, b) {
  return Cartesian3.equalsEpsilon(a, b, 0, 1e-3);
}

function pathBetween(a, b, arcType) {
  const ca = toCartographic(a, scratchA);
  const cb = toCartographic(b, scratchB);
  return arcType === ArcType.RHUMB
    ? new EllipsoidRhumbLine(ca, cb, ellipsoid)
    : new EllipsoidGeodesic(ca, cb, ellipsoid);
}

/** Surface distance between two positions. */
export function distance(a, b, arcType = ArcType.GEODESIC) {
  if (isSamePoint(a, b)) {
    return 0;
  }
  return pathBetween(a, b, arcType).surfaceDistance;
}

/** Bearing from a towards b, at a. */
export function bearing(a, b, arcType = ArcType.GEODESIC) {
  if (isSamePoint(a, b)) {
    return 0;
  }
  const path = pathBetween(a, b, arcType);
  return arcType === ArcType.RHUMB ? path.heading : path.startHeading;
}

/** Heading of the path from a to b when it arrives at b. */
export function arrivalBearing(a, b, arcType = ArcType.GEODESIC) {
  if (isSamePoint(a, b)) {
    return 0;
  }
  const path = pathBetween(a, b, arcType);
  return arcType === ArcType.RHUMB ? path.heading : path.endHeading;
}

/**
 * The position `meters` from `origin` along `bearing`. The result has the given height
 * (default: the origin's height).
 */
export function destination(origin, bearingRadians, meters, arcType = ArcType.GEODESIC, height) {
  const start = toCartographic(origin, new Cartographic());
  const h = height ?? start.height;
  if (!(meters > 0)) {
    return Cartesian3.fromRadians(start.longitude, start.latitude, h);
  }
  if (arcType === ArcType.RHUMB) {
    // A rhumb line reaches a pole after a finite distance and can't go past it: Cesium then
    // throws, or returns a latitude beyond ±90°. Fall back to the geodesic, which can.
    try {
      const line = EllipsoidRhumbLine.fromStartHeadingDistance(
        new Cartographic(start.longitude, start.latitude, 0),
        bearingRadians,
        meters,
        ellipsoid,
      );
      const end = line.end;
      if (Number.isFinite(end.longitude) && Math.abs(end.latitude) <= CesiumMath.PI_OVER_TWO) {
        return Cartesian3.fromRadians(end.longitude, end.latitude, h);
      }
    } catch {
      // past the pole; see above
    }
  }
  const [lon, lat] = vincentyDirect(start.longitude, start.latitude, bearingRadians, meters);
  return Cartesian3.fromRadians(lon, lat, h);
}

// Vincenty's direct formula on WGS84 (Cesium only has the inverse problem).
const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);

function vincentyDirect(lon1, lat1, alpha1, s) {
  const a = WGS84_A;
  const b = WGS84_B;
  const f = WGS84_F;
  const sinAlpha1 = Math.sin(alpha1);
  const cosAlpha1 = Math.cos(alpha1);
  const tanU1 = (1 - f) * Math.tan(lat1);
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
  const sinU1 = tanU1 * cosU1;
  const sigma1 = Math.atan2(tanU1, cosAlpha1);
  const sinAlpha = cosU1 * sinAlpha1;
  const cosSqAlpha = 1 - sinAlpha * sinAlpha;
  const uSq = (cosSqAlpha * (a * a - b * b)) / (b * b);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));

  let sigma = s / (b * A);
  let sinSigma;
  let cosSigma;
  let cos2SigmaM;
  for (let i = 0; i < 100; i++) {
    cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    sinSigma = Math.sin(sigma);
    cosSigma = Math.cos(sigma);
    const deltaSigma =
      B *
      sinSigma *
      (cos2SigmaM +
        (B / 4) *
          (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            (B / 6) *
              cos2SigmaM *
              (-3 + 4 * sinSigma * sinSigma) *
              (-3 + 4 * cos2SigmaM * cos2SigmaM)));
    const next = s / (b * A) + deltaSigma;
    if (Math.abs(next - sigma) < 1e-12) {
      sigma = next;
      break;
    }
    sigma = next;
  }
  cos2SigmaM = Math.cos(2 * sigma1 + sigma);
  sinSigma = Math.sin(sigma);
  cosSigma = Math.cos(sigma);

  const tmp = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1;
  const lat2 = Math.atan2(
    sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1,
    (1 - f) * Math.sqrt(sinAlpha * sinAlpha + tmp * tmp),
  );
  const lambda = Math.atan2(sinSigma * sinAlpha1, cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1);
  const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
  const L =
    lambda -
    (1 - C) *
      f *
      sinAlpha *
      (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
  return [CesiumMath.negativePiToPi(lon1 + L), lat2];
}

/** The point at `fraction` (0..1) along the path from a to b; heights are interpolated. */
export function interpolate(a, b, fraction, arcType = ArcType.GEODESIC) {
  const ha = heightOf(a);
  const hb = heightOf(b);
  if (isSamePoint(a, b)) {
    return Cartesian3.clone(a);
  }
  const c = pathBetween(a, b, arcType).interpolateUsingFraction(fraction, new Cartographic());
  return Cartesian3.fromRadians(c.longitude, c.latitude, ha + (hb - ha) * fraction);
}

/** Total surface length of a line (closed when `loop`). */
export function lineLength(positions, arcType = ArcType.GEODESIC, loop = false) {
  let length = 0;
  for (let i = 1; i < positions.length; i++) {
    length += distance(positions[i - 1], positions[i], arcType);
  }
  if (loop && positions.length > 2) {
    length += distance(positions[positions.length - 1], positions[0], arcType);
  }
  return length;
}

/**
 * Inserts points so that no piece is longer than `maxSegmentMeters`, following the arc type.
 * The original vertices are kept. With `loop`, the closing segment is densified too, and the
 * result ends just before returning to the first point.
 */
export function densify(positions, arcType, maxSegmentMeters, loop = false) {
  const count = positions.length;
  if (count < 2 || !(maxSegmentMeters > 0)) {
    return positions.slice();
  }
  const result = [];
  const segments = loop ? count : count - 1;
  for (let i = 0; i < segments; i++) {
    const a = positions[i];
    const b = positions[(i + 1) % count];
    result.push(a);
    const pieces = Math.min(Math.ceil(distance(a, b, arcType) / maxSegmentMeters), 4096);
    if (pieces > 1) {
      const path = pathBetween(a, b, arcType);
      const ha = heightOf(a);
      const hb = heightOf(b);
      for (let k = 1; k < pieces; k++) {
        const t = k / pieces;
        const c = path.interpolateUsingFraction(t, scratchA);
        result.push(Cartesian3.fromRadians(c.longitude, c.latitude, ha + (hb - ha) * t));
      }
    }
  }
  if (!loop) {
    result.push(positions[count - 1]);
  }
  return result;
}

/**
 * Points of the arc around `center` at `radius`, from `fromBearing` clockwise to `toBearing`
 * (both included), `segments` pieces. Each point is reached from the center along `arcType`.
 */
export function sampleArc(center, radius, fromBearing, toBearing, segments, arcType, height) {
  const sweep = toBearing - fromBearing;
  const points = [];
  for (let i = 0; i <= segments; i++) {
    points.push(destination(center, fromBearing + (sweep * i) / segments, radius, arcType, height));
  }
  return points;
}

/** Clockwise angle from bearing `from` to bearing `to`, in [0, 2π). */
export function clockwiseSweep(from, to) {
  return CesiumMath.zeroToTwoPi(to - from) % TWO_PI;
}

/**
 * Signed cross-track distance (meters) from `point` to the path from a to b, positive to the
 * right of it. Spherical approximation (mean radius); good enough for edit handles.
 */
export function crossTrackDistance(point, a, b, arcType = ArcType.GEODESIC) {
  const d13 = distance(a, point, ArcType.GEODESIC);
  const theta13 = bearing(a, point, ArcType.GEODESIC);
  const theta12 = bearing(a, b, arcType);
  const R = 6371008.8;
  return Math.asin(Math.sin(d13 / R) * Math.sin(theta13 - theta12)) * R;
}

// Smallest turn from bearing `a` to bearing `b`, in (-π, π]; positive = clockwise (right).
function turn(a, b) {
  return CesiumMath.negativePiToPi(b - a);
}

/**
 * A line offset `offsetMeters` beside a (densified) centerline: positive = to the right of
 * the direction of travel, negative = left. Corners on the outer side of a turn are mitered
 * (CornerType.MITERED, limited to 4× the offset), beveled (BEVELED) or rounded (ROUNDED);
 * inner corners are always mitered. Densify the centerline first for long segments: only
 * the given points are offset.
 */
export function offsetLine(centerline, offsetMeters, arcType = ArcType.GEODESIC, cornerType = CornerType.MITERED) {
  const n = centerline.length;
  if (n < 2 || offsetMeters === 0) {
    return centerline.slice();
  }
  const side = Math.sign(offsetMeters);
  const offset = Math.abs(offsetMeters);
  const normal = (b) => b + side * CesiumMath.PI_OVER_TWO;
  const result = [];
  for (let i = 0; i < n; i++) {
    const p = centerline[i];
    if (i === 0) {
      result.push(destination(p, normal(bearing(p, centerline[1], arcType)), offset, arcType));
      continue;
    }
    if (i === n - 1) {
      result.push(destination(p, normal(arrivalBearing(centerline[i - 1], p, arcType)), offset, arcType));
      continue;
    }
    const incoming = arrivalBearing(centerline[i - 1], p, arcType);
    const outgoing = bearing(p, centerline[i + 1], arcType);
    const t = turn(incoming, outgoing);
    const outer = Math.sign(t) !== side && Math.abs(t) > 1e-6;
    if (outer && cornerType === CornerType.ROUNDED) {
      const steps = Math.max(2, Math.ceil(Math.abs(t) / CesiumMath.toRadians(10)));
      for (let k = 0; k <= steps; k++) {
        result.push(destination(p, normal(incoming + (t * k) / steps), offset, arcType));
      }
    } else if (outer && cornerType === CornerType.BEVELED) {
      result.push(destination(p, normal(incoming), offset, arcType));
      result.push(destination(p, normal(outgoing), offset, arcType));
    } else {
      const miter = Math.min(1 / Math.max(Math.cos(t / 2), 1e-6), 4);
      result.push(destination(p, normal(incoming + t / 2), offset * miter, arcType));
    }
  }
  return result;
}

/**
 * Closed outline of a corridor: the right edge, the end cap, the left edge backwards and the
 * start cap. Caps are round for CornerType.ROUNDED (like CorridorGeometry) and flat otherwise.
 */
export function corridorOutline(centerline, width, arcType, cornerType = CornerType.ROUNDED) {
  const n = centerline.length;
  if (n < 2 || !(width > 0)) {
    return [];
  }
  const half = width / 2;
  const right = offsetLine(centerline, half, arcType, cornerType);
  const left = offsetLine(centerline, -half, arcType, cornerType);
  const loop = [...right];
  if (cornerType === CornerType.ROUNDED) {
    const end = centerline[n - 1];
    const endHeading = arrivalBearing(centerline[n - 2], end, arcType);
    // From the right side, around the front, to the left side (counterclockwise).
    loop.push(...capArc(end, half, endHeading + CesiumMath.PI_OVER_TWO, -Math.PI, arcType));
  }
  loop.push(...left.reverse());
  if (cornerType === CornerType.ROUNDED) {
    const start = centerline[0];
    const startHeading = bearing(start, centerline[1], arcType);
    // From the left side, around the back, to the right side.
    loop.push(...capArc(start, half, startHeading - CesiumMath.PI_OVER_TWO, -Math.PI, arcType));
  }
  return loop;
}

// Interior points of a half-circle cap (the end points are already on the edges).
function capArc(center, radius, fromBearing, sweep, arcType) {
  const steps = 12;
  const points = [];
  for (let k = 1; k < steps; k++) {
    points.push(destination(center, fromBearing + (sweep * k) / steps, radius, arcType));
  }
  return points;
}

/**
 * Rotates every position about the earth's center by the rotation that takes `from` to `to`
 * (on the surface), keeping each position's height. Moves a shape without stretching it,
 * unlike shifting longitudes and latitudes.
 */
export function rotatePositions(positions, from, to) {
  const a = Cartesian3.normalize(withHeight(from, 0), new Cartesian3());
  const b = Cartesian3.normalize(withHeight(to, 0), new Cartesian3());
  const angle = Cartesian3.angleBetween(a, b);
  if (!(angle > 1e-12)) {
    return positions.map((p) => Cartesian3.clone(p));
  }
  const axis = Cartesian3.normalize(Cartesian3.cross(a, b, new Cartesian3()), new Cartesian3());
  const rotation = Matrix3.fromQuaternion(Quaternion.fromAxisAngle(axis, angle));
  return positions.map((p) => {
    const height = heightOf(p);
    const surface = withHeight(p, 0);
    const rotated = Matrix3.multiplyByVector(rotation, surface, new Cartesian3());
    return withHeight(rotated, height);
  });
}

/** Center of the positions on the surface, at their average height. */
export function centroid(positions) {
  if (positions.length === 0) {
    return undefined;
  }
  const center = BoundingSphere.fromPoints(positions).center;
  const surface = ellipsoid.scaleToGeodeticSurface(center, new Cartesian3()) ?? positions[0];
  const height = positions.reduce((sum, p) => sum + heightOf(p), 0) / positions.length;
  return withHeight(surface, height);
}

// Geometry detail scales with the shape's size, so rebuilding it costs about the same for a
// city as for a continent (see renderer.js). `factor` > 1 makes it coarser (interactive edits).
export const DEFAULT_DETAIL = {
  lineSegments: 256, // target pieces per ground line
  minLineGranularity: 9999, // meters
  maxLineGranularity: 200000, // meters
  polygonCells: 32, // target grid cells across a polygon
  minPolygonGranularity: CesiumMath.RADIANS_PER_DEGREE,
  maxPolygonGranularity: 5 * CesiumMath.RADIANS_PER_DEGREE,
  arcSegments: 256, // pieces of a full circle
  interactiveFactor: 4, // coarser by this much while drawing / dragging
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** GroundPolylineGeometry granularity (meters) for a line. */
export function lineGranularity(positions, loop, detail, factor = 1) {
  const length = lineLength(positions, ArcType.GEODESIC, loop);
  return clamp(
    (length * factor) / detail.lineSegments,
    detail.minLineGranularity,
    detail.maxLineGranularity * factor,
  );
}

/** PolygonGeometry / CorridorGeometry granularity (radians) for an area. */
export function polygonGranularity(positions, detail, factor = 1) {
  const radius = BoundingSphere.fromPoints(positions).radius;
  const extent = (2 * radius) / ellipsoid.maximumRadius;
  return clamp(
    (extent * factor) / detail.polygonCells,
    detail.minPolygonGranularity,
    detail.maxPolygonGranularity * factor,
  );
}
