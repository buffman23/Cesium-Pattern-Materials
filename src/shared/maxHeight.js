import { EllipsoidGeodesic, Rectangle } from "cesium";

/**
 * Patterns keep a near-constant on-screen size by scaling with the camera height. Above a max
 * height they stop scaling and keep their ground size instead (shrinking on screen like paint),
 * easing in over a transition below it. Returns the factor to multiply the pattern's
 * meters-per-pixel by: effectiveHeight / height, where
 *
 *   effectiveHeight = h                                  for h <= H - T
 *                   = h - (h - (H - T))^2 / (2 T)        for H - T < h < H (slope eases 1 -> 0)
 *                   = H - T / 2                          for h >= H        (size frozen)
 *
 * With T = 0 that is a hard min(h, H); with H = Infinity (off) the factor is 1.
 *
 * @param {number} height Camera height above the ellipsoid, meters.
 * @param {number} maxHeight H, meters (Infinity = off).
 * @param {number} transition T, meters (0..H).
 * @returns {number} Factor in (0, 1].
 */
export function sizeScale(height, maxHeight, transition) {
  if (!Number.isFinite(maxHeight) || !(height > 0)) {
    return 1;
  }
  const t = Math.min(Math.max(transition, 0), maxHeight);
  const start = maxHeight - t;
  let effective;
  if (height <= start) {
    effective = height;
  } else if (height >= maxHeight) {
    effective = maxHeight - t / 2;
  } else {
    effective = height - (height - start) ** 2 / (2 * t);
  }
  return Math.min(effective / height, 1);
}

/**
 * Length (meters, along the ground) of the diagonal of the positions' longitude/latitude
 * bounding box; 0 for fewer than two distinct positions.
 *
 * @param {Cartesian3[]} positions
 * @returns {number}
 */
export function boundingBoxDiagonal(positions) {
  if (positions.length < 2) {
    return 0;
  }
  const box = Rectangle.fromCartesianArray(positions);
  if (!(box.width > 0 || box.height > 0)) {
    return 0;
  }
  return new EllipsoidGeodesic(Rectangle.southwest(box), Rectangle.northeast(box)).surfaceDistance;
}

/**
 * Max height fitted to a shape, in units of its "fit height": the camera height at which the
 * shape's bounding box diagonal just fills the view vertically (looking straight down). With
 * factor 1 the pattern stops scaling once the whole shape is in view; larger factors let it
 * keep scaling longer. The transition starts at `easeFrom` fit heights (<= factor). A
 * degenerate shape, or factor Infinity, gets no max height.
 *
 * @param {number} diagonal From {@link boundingBoxDiagonal}, meters.
 * @param {Camera} camera
 * @param {number} factor Max height, in fit heights (Infinity = off).
 * @param {number} easeFrom Where the transition starts, in fit heights.
 * @returns {{maxHeight: number, heightTransition: number}}
 */
export function fitMaxHeight(diagonal, camera, factor, easeFrom) {
  if (!(diagonal > 0) || !Number.isFinite(factor)) {
    return { maxHeight: Infinity, heightTransition: 0 };
  }
  const fovy = camera.frustum.fovy ?? Math.PI / 3;
  const fitHeight = diagonal / (2 * Math.tan(fovy / 2));
  const maxHeight = factor * fitHeight;
  const start = Math.min(Math.max(easeFrom, 0), factor) * fitHeight;
  return { maxHeight, heightTransition: maxHeight - start };
}
