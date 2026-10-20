import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  Ellipsoid,
  Material,
  Matrix4,
  Transforms,
} from "cesium";
import mipmapTexture from "../../shared/mipmapTexture.js";
import {
  createZoomSettle,
  referenceMetersPerPixel,
  updateZoomSettle,
} from "../../shared/zoomSettle.js";

// Works with any primitive whose material input provides positionToEyeEC (GroundPrimitive,
// Primitive + MaterialAppearance). Texture coordinates are not used at all: each fragment is
// mapped to local east/north meters around the polygon, so the pattern is anchored to the
// ground, tiles are square and independent of how the geometry builds st.
//
// The ground point is NOT taken from positionToEyeEC directly. For ground primitives that
// position is reconstructed from the depth buffer, which is too coarse for a fine pattern
// (the hatch breaks into blocks/streaks and averages into a flat fill). Only its direction is
// used: the view ray is intersected with a sphere tangent to the ellipsoid directly below the
// camera (refit every frame), expressed in the polygon's local frame. (Assumes no terrain: the surface is the ellipsoid.)
//
// Precision: the camera can be ~1000 km from the polygon's origin, which float32 only resolves
// to ~6 cm - the pattern would stutter in 6 cm jumps when panning at max zoom. So everything
// large is prepared on the CPU in double precision: the camera height above the sphere, the
// direction from the sphere center to the camera, and the camera's east/north position split
// into float high + low parts. The shader only does math relative to the camera, and wraps the
// high part by the (power-of-two) tile size, which is exact in float.
//
// To stay visible at any zoom, the tile size is a power of two in meters picked per fragment
// from the pixel size at that distance so a tile is ~tileSize pixels, and just before it
// doubles the two nearest power-of-two scales are cross-faded. A seamless pattern whose 2x
// scale lines up with itself (like the 45 degree hatch) blends smoothly.
const source = /* glsl */ `
uniform sampler2D image;
uniform vec4 color;
uniform float tileSize;
uniform mat4 eyeToLocal;
uniform float radius;
uniform float cameraHeight;     // camera height above the sphere (meters)
uniform vec3 cameraUp;          // unit vector from the sphere center to the camera, local frame
uniform vec2 cameraHigh;        // camera east/north = cameraHigh + cameraLow
uniform vec2 cameraLow;
uniform float levelShift;       // keeps the cross-fade from resting half faded; see zoomSettle

czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);

    // Until the image has loaded, Material binds Cesium's 1x1 white placeholder texture, which
    // would render as a solid block. Draw nothing until the real image is there.
    if (textureSize(image, 0).x <= 1) {
        discard;
    }

    // View ray in eye space, then in the local east-north-up frame (meters, z = up).
    vec3 directionEC = normalize(-materialInput.positionToEyeEC);
    vec3 direction = normalize(mat3(eyeToLocal) * directionEC);

    // Nearest intersection with the sphere (center C, camera o):
    //   t^2 + 2bt + c = 0, b = dot(o - C, d), c = |o - C|^2 - radius^2 = h (h + 2 radius)
    // The near root is written as c / (-b + sqrt(b^2 - c)) to avoid cancellation.
    float b = (radius + cameraHeight) * dot(cameraUp, direction);
    float c = cameraHeight * (cameraHeight + 2.0 * radius);
    float t = c / (-b + sqrt(max(b * b - c, 0.0)));
    vec2 p = cameraLow + t * direction.xy;   // meters east/north, minus cameraHigh
    vec2 gradX = dFdx(p);
    vec2 gradY = dFdy(p);
    float metersPerPixel = max(czm_metersPerPixel(vec4(directionEC * t, 1.0)), 1e-6);

    // czm_metersPerPixel is per CSS pixel (it already includes the pixel ratio), like tileSize.
    // The +0.5 centres the tile on tileSize: size0 is ~0.7x..1.4x tileSize pixels. The two
    // scales cross-fade over the last 20% of a level (fract(level) in 0.8..1).
    float level = log2(tileSize * metersPerPixel) + 0.5 + levelShift;
    float k = floor(level);
    float blend = smoothstep(0.8, 1.0, level - k);
    float size0 = exp2(k);
    float size1 = size0 * 2.0;

    vec2 uv0 = (mod(cameraHigh, size0) + p) / size0;
    vec2 uv1 = (mod(cameraHigh, size1) + p) / size1;
    vec4 tex0 = textureGrad(image, uv0, gradX / size0, gradY / size0);
    vec4 tex1 = textureGrad(image, uv1, gradX / size1, gradY / size1);
    vec4 tex = mix(tex0, tex1, blend);

    // Un-premultiply: filtering blends in the black of transparent texels.
    tex.rgb = min(tex.rgb / max(tex.a, 0.0001), 1.0);
    vec4 fragColor = tex * color;
    if (fragColor.a < 0.005) {
        discard;
    }

    fragColor = czm_gammaCorrect(fragColor);
    material.diffuse = fragColor.rgb;
    material.alpha = fragColor.a;
    return material;
}
`;

const scratchModelView = new Matrix4();
const scratchEyeToLocal = new Matrix4();
const scratchCamera = new Cartesian3();
const scratchFromCenter = new Cartesian3();
const scratchNadir = new Cartesian3();
const scratchUp = new Cartesian3();
const scratchCenter = new Cartesian3();
const scratchCartographic = new Cartographic();

/**
 * Material that fills a polygon with a repeated, ground-anchored image tile whose on-screen
 * size stays roughly constant (`tileSize` pixels, adapting in powers of two) at any zoom.
 *
 * Call {@link PolygonPatternMaterial.setOrigin} when the polygon changes and
 * {@link PolygonPatternMaterial.updateCamera} every frame (e.g. from scene.preRender).
 */
export default class PolygonPatternMaterial {
  static TYPE = "PolygonPatternWorld";

  /**
   * @param {object} options
   * @param {string|HTMLImageElement|HTMLCanvasElement} options.image Seamless tile image.
   * @param {Color} [options.color=Color.WHITE] Tint multiplied with the image.
   * @param {number} [options.tileSize=48] Approximate on-screen tile size, in pixels.
   * @returns {Material}
   */
  static create({ image, color = Color.WHITE, tileSize = 48 }) {
    const material = new Material({
      fabric: {
        type: PolygonPatternMaterial.TYPE,
        // Material only recognizes matrix uniforms given as plain column-major arrays.
        uniforms: {
          image,
          color,
          tileSize,
          eyeToLocal: Matrix4.toArray(Matrix4.IDENTITY),
          radius: Ellipsoid.WGS84.maximumRadius,
          cameraHeight: 1,
          cameraUp: new Cartesian3(0, 0, 1),
          cameraHigh: new Cartesian2(),
          cameraLow: new Cartesian2(),
          levelShift: 0,
        },
        source,
      },
      translucent: true,
    });
    material.localToWorld = Matrix4.clone(Matrix4.IDENTITY);
    material.worldToLocal = Matrix4.clone(Matrix4.IDENTITY);
    material.zoomSettle = createZoomSettle();
    return mipmapTexture(material, "image");
  }

  /**
   * Anchors the pattern to an east-north-up frame on the ellipsoid surface below the center of
   * the given positions.
   *
   * @param {Material} material
   * @param {Cartesian3[]} positions
   */
  static setOrigin(material, positions) {
    const center = Ellipsoid.WGS84.scaleToGeodeticSurface(
      BoundingSphere.fromPoints(positions).center,
      new Cartesian3(),
    );
    Transforms.eastNorthUpToFixedFrame(center, Ellipsoid.WGS84, material.localToWorld);
    Matrix4.inverseTransformation(material.localToWorld, material.worldToLocal);
  }

  /**
   * Refreshes the camera-dependent uniforms. Done on the CPU in double precision so the
   * pattern stays locked to the ground when zoomed in close (see the note at the top).
   *
   * The ground sphere is refit every frame to touch the ellipsoid directly below the camera:
   * that is where precision matters, and a sphere fit at the polygon's center would sit tens of
   * meters below the real surface far from the center, making the pattern lag the camera.
   *
   * It also advances the zoom fade's level shift (see zoomSettle); while that is settling after
   * the camera height stops changing, it requests further frames itself.
   *
   * @param {Material} material
   * @param {Scene} scene
   */
  static updateCamera(material, scene) {
    const camera = scene.camera;
    const uniforms = material.uniforms;
    const level = Math.log2(uniforms.tileSize * referenceMetersPerPixel(scene)) + 0.5;
    uniforms.levelShift = updateZoomSettle(material.zoomSettle, scene, {
      tile: { level, window: [0.8, 1] },
    }).tile;

    Matrix4.multiply(camera.viewMatrix, material.localToWorld, scratchModelView);
    Matrix4.inverseTransformation(scratchModelView, scratchEyeToLocal);
    Matrix4.pack(scratchEyeToLocal, uniforms.eyeToLocal);

    // Sphere tangent to the ellipsoid below the camera, in the polygon's local frame.
    const ellipsoid = Ellipsoid.WGS84;
    const nadir = ellipsoid.scaleToGeodeticSurface(camera.positionWC, scratchNadir);
    if (!nadir) {
      return; // camera at the earth's center; nothing sensible to do
    }
    const up = ellipsoid.geodeticSurfaceNormal(nadir, scratchUp);
    const radius = gaussianRadius(ellipsoid, nadir);
    const centerWorld = Cartesian3.subtract(
      nadir,
      Cartesian3.multiplyByScalar(up, radius, scratchCenter),
      scratchCenter,
    );
    const center = Matrix4.multiplyByPoint(material.worldToLocal, centerWorld, scratchCenter);

    const eye = Matrix4.getTranslation(scratchEyeToLocal, scratchCamera); // camera, local frame
    const fromCenter = Cartesian3.subtract(eye, center, scratchFromCenter);
    const distance = Cartesian3.magnitude(fromCenter);
    uniforms.radius = radius;
    uniforms.cameraHeight = distance - radius;
    Cartesian3.divideByScalar(fromCenter, distance, uniforms.cameraUp);
    uniforms.cameraHigh.x = Math.fround(eye.x);
    uniforms.cameraHigh.y = Math.fround(eye.y);
    uniforms.cameraLow.x = eye.x - uniforms.cameraHigh.x;
    uniforms.cameraLow.y = eye.y - uniforms.cameraHigh.y;
  }
}

/** Gaussian radius of curvature sqrt(M * N) of the ellipsoid at a surface point. */
function gaussianRadius(ellipsoid, surfacePoint) {
  const a = ellipsoid.maximumRadius;
  const e2 = 1 - (ellipsoid.minimumRadius / a) ** 2;
  const sinLat = Math.sin(ellipsoid.cartesianToCartographic(surfacePoint, scratchCartographic).latitude);
  const w2 = 1 - e2 * sinLat * sinLat;
  const n = a / Math.sqrt(w2);
  const m = (a * (1 - e2)) / (w2 * Math.sqrt(w2));
  return Math.sqrt(m * n);
}
