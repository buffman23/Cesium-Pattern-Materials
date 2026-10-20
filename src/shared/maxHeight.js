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
