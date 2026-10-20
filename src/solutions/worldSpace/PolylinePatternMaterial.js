import {
  Cartesian2,
  Cartesian3,
  Cartesian4,
  Cartographic,
  Color,
  Ellipsoid,
  EllipsoidGeodesic,
  Material,
  Matrix4,
  PixelDatatype,
  PixelFormat,
  Sampler,
  Texture,
  TextureMagnificationFilter,
  TextureMinificationFilter,
  TextureWrap,
} from "cesium";
import mipmapTexture from "../../shared/mipmapTexture.js";

// Intended for GroundPolylinePrimitive, whose fragment shader provides st.s as arc length
// along the whole line normalized to 0..1, and st.t as 0..1 across the line width.
//
// The image is one stamp: it is drawn undistorted, as tall as the line is wide, so a stamp is
// `lineWidth * imageWidth / imageHeight` pixels long. The line width comes from the primitive
// (v_width), the aspect ratio from the loaded texture, so neither needs to be configured. To
// space stamps further apart, pad the image (e.g. plain line on both sides of the symbol) or
// raise the `spacing` multiplier, which only adds gap between stamps (below 1 they overlap).
//
// Stamps are anchored to positions along the line (they don't slide when the camera moves):
//  - Stamps are sized like the ground polyline's own width: pixels converted to meters at the
//    fragment's depth. Seen top-down they are a constant pixel size at any zoom; when the
//    camera tilts they foreshorten together with the draped line, like a ground decal.
//  - Stamp spacing is 2^k meters, with k chosen per fragment so the spacing is between 1x and
//    2x the repeat length (stamp length * spacing).
//  - Every second stamp fades out as the spacing approaches the next power of two, so there
//    is no popping when k changes while zooming.
//  - Between stamps the image's edge column is extended (CLAMP_TO_EDGE wrap), which for a
//    "line with a symbol" stamp keeps the line continuous through the gaps.
//
// Vertices (`vertexMode`, see PolylinePatternMaterial.VertexMode). At a vertex the line changes
// direction, so a stamp straddling it would be torn in two. In the mitered wedge on the outside
// of a corner GroundPolylinePrimitive clamps st.s to the vertex, so every wedge pixel would read
// one image column and smear it; the wedge therefore always gets the plain edge column.
//  - SKIP:   stamps on the global grid; any stamp that would overlap a vertex is left out.
//  - CLIP:   stamps on the global grid run right up to the vertex and are cut off there (a pixel
//            only draws stamps centred in its own segment).
//  - SNAP:   stamps at evenly divided points of each segment (power-of-two divisions, so zoom
//            levels nest without popping); the gap at a vertex equals the interior spacing.
//  - FIT:    per segment, the first and last stamp touch the vertices, the rest evenly spaced.
//            Stamp ground length changes with zoom, so stamps shift slightly while zooming.
//  - CORNER: SKIP, plus the stamp's symbol drawn centred on every interior vertex, aligned with
//            the corner's mean direction. Corner frames are computed on the CPU every frame.
// Vertex distances come from a float data texture, so any vertex count works.
//
// Precision: st.s is a float32 fraction of the whole line, so distance along the line is only
// resolved to lineLength * 2^-24 (22 cm on a 3,600 km line). Zoomed in close, stamps would
// smear and vanish. Where that step size matters (metersPerPixel < preciseMetersPerPixel), the
// distance is instead measured in eye space from reference points on the line near the camera,
// computed every frame on the CPU in double precision (see updateCamera). Their distances along
// the line are passed modulo a power of two larger than any stamp spacing used there, so stamp
// positions and the every-second-stamp fade stay consistent.
const source = /* glsl */ `
in float v_width;               // line width in pixels, provided by GroundPolylinePrimitive

const float MIN_SPACING = 0.25; // below 1, stamps overlap; see the stamp loop
const float MODE_SKIP = 0.0;
const float MODE_CLIP = 1.0;
const float MODE_SNAP = 2.0;
const float MODE_FIT = 3.0;
const float MODE_CORNER = 4.0;

uniform sampler2D image;
uniform vec4 color;
uniform float spacing;          // repeat length as a multiple of the stamp length (>= 0.25)
uniform float vertexMode;       // one of the MODE_* values
uniform float lineLength;
uniform float preciseMetersPerPixel;
uniform vec4 referenceA;        // xyz: point on the line (eye coords), w: distance mod modulus
uniform vec4 tangentA;          // xyz: line direction there (eye coords), w: 1 if valid
uniform vec4 referenceB;        // same for the second-nearest segment (corners)
uniform vec4 tangentB;
uniform vec2 rangeA;            // distance along the line from referenceA to its segment's ends
uniform vec2 rangeB;
uniform sampler2D vertexDistances;  // r: distance along the line of each vertex, ascending
uniform float vertexCount;
// CORNER mode. Per vertex (texel x = vertex index), eye coordinates: row 0 = position, w = 1
// for an interior vertex; row 1 = symbol x axis; row 2 = symbol y axis.
uniform sampler2D cornerFrames;
uniform vec4 nearCorner;        // close-zoom path: the corner nearest the camera (w: 1 if any)
uniform vec4 nearCornerX;
uniform vec4 nearCornerY;

float vertexDistanceAt(int i)
{
    return texelFetch(vertexDistances, ivec2(i, 0), 0).r;
}

// Index i of the segment [vertex i, vertex i + 1] containing c (clamped to the first / last
// segment), by binary search. Requires vertexCount >= 2.
int segmentIndex(float c)
{
    int lo = 0;
    int hi = int(vertexCount) - 1;
    for (int i = 0; i < 32; i++) {
        if (hi - lo <= 1) {
            break;
        }
        int mid = (lo + hi) / 2;
        if (vertexDistanceAt(mid) <= c) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return lo;
}

// Distance from c (meters along the line) to the nearest vertex.
float nearestVertexGap(float c)
{
    if (vertexCount < 2.0) {
        return 1e30;
    }
    int i = segmentIndex(c);
    return min(abs(c - vertexDistanceAt(i)), abs(c - vertexDistanceAt(i + 1)));
}

// How much of stamp number "i", centred at "center", to draw (0..1).
float stampKeep(float i, float center, float fadeOut, float halfStamp, float segmentStart,
                float segmentEnd, bool precise, vec2 preciseVertices)
{
    // Every second stamp fades out as the spacing level approaches the next power of two.
    float keep = mod(i, 2.0) < 0.5 ? 1.0 : 1.0 - fadeOut;
    if (vertexMode == MODE_CLIP) {
        // Run up to the vertex, but only draw stamps centred in this fragment's own segment.
        return center >= segmentStart && center <= segmentEnd ? keep : 0.0;
    }
    if (vertexMode == MODE_FIT) {
        return keep;   // laid out to touch the vertices exactly, never across them
    }
    // Drop stamps that would overlap a vertex (fading over the last 20% so they don't pop).
    float vertexGap = precise
        ? min(abs(center - preciseVertices.x), abs(center - preciseVertices.y))
        : nearestVertexGap(center);
    return keep * smoothstep(halfStamp, 1.2 * halfStamp, vertexGap);
}

czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);

    // Until the image has loaded, Material binds Cesium's 1x1 white placeholder texture, which
    // would render as a solid block. Draw nothing until the real image is there.
    if (textureSize(image, 0).x <= 1) {
        discard;
    }

    // In the mitered wedge outside a corner st.s is clamped to the vertex, so it doesn't change
    // from pixel to pixel. (Derivatives must be taken here, in uniform control flow.)
    float sChange = abs(dFdx(materialInput.st.s)) + abs(dFdy(materialInput.st.s));

    float d = materialInput.st.s * lineLength;     // meters along the line

    // Pixel size on the ground at this fragment, computed the same way GroundPolylinePrimitive
    // sizes the line width (from the globe depth). Screen-space derivatives of d would be
    // noisy, because d itself is reconstructed from depth.
    float depth = czm_unpackDepth(texture(czm_globeDepthTexture, gl_FragCoord.xy / czm_viewport.zw));
    vec4 eyeCoordinate = czm_windowToEyeCoordinates(gl_FragCoord.xy, depth);
    eyeCoordinate /= eyeCoordinate.w;
    // Meters per CSS pixel (czm_metersPerPixel includes the pixel ratio), the same units as
    // v_width, so the stamp keeps the image's aspect ratio relative to the drawn line width.
    float metersPerPixel = max(czm_metersPerPixel(eyeCoordinate), 1e-6);
    vec2 imageSize = vec2(textureSize(image, 0));
    float stampPixels = v_width * imageSize.x / imageSize.y;
    float repeatPixels = stampPixels * max(spacing, MIN_SPACING);
    float stampMeters = stampPixels * metersPerPixel;
    float halfStamp = 0.5 * stampMeters;

    // Zoomed in close: measure along the line from the nearest reference point instead.
    bool precise = false;
    vec2 preciseVertices = vec2(0.0);   // the chosen segment's two ends, same units as d
    if (metersPerPixel < preciseMetersPerPixel && tangentA.w > 0.5) {
        precise = true;
        vec3 toA = eyeCoordinate.xyz - referenceA.xyz;
        vec3 toB = eyeCoordinate.xyz - referenceB.xyz;
        float alongA = dot(toA, tangentA.xyz);
        float alongB = dot(toB, tangentB.xyz);
        float offA = length(toA - alongA * tangentA.xyz);
        float offB = tangentB.w > 0.5 ? length(toB - alongB * tangentB.xyz) : 1e30;
        bool useA = offA <= offB;
        d = useA ? referenceA.w + alongA : referenceB.w + alongB;
        preciseVertices = useA ? referenceA.w + rangeA : referenceB.w + rangeB;
    }

    // The segment this fragment is on, and whether it is in a corner's mitered wedge.
    float segmentStart = 0.0;
    float segmentEnd = lineLength;
    int segment = 0;
    if (precise) {
        segmentStart = preciseVertices.x;
        segmentEnd = preciseVertices.y;
    } else if (vertexCount >= 2.0) {
        segment = segmentIndex(d);
        segmentStart = vertexDistanceAt(segment);
        segmentEnd = vertexDistanceAt(segment + 1);
    }
    bool wedge = precise ? (d < segmentStart || d > segmentEnd) : sChange == 0.0;

    // Spacing level: 2^level meters is exactly one repeat length on screen.
    float level = log2(repeatPixels * metersPerPixel);
    float k = ceil(level);
    float gridSpacing = exp2(k);                    // 1x..2x the repeat length on screen
    float fadeOut = smoothstep(0.5, 1.0, 1.0 - (k - level));

    // Stamp centres are origin + i * stampStep, for whole numbers i in [first, last].
    float origin = 0.0;
    float stampStep = gridSpacing;
    float first = -1e30;
    float last = 1e30;
    if (vertexMode == MODE_SNAP || vertexMode == MODE_FIT) {
        float segmentLength = segmentEnd - segmentStart;
        float available = vertexMode == MODE_FIT ? segmentLength - stampMeters : segmentLength;
        // Power-of-two divisions, so the next zoom level's stamps are a subset of these.
        float divisions = available >= gridSpacing ? exp2(floor(log2(available / gridSpacing))) : 0.0;
        if (vertexMode == MODE_SNAP) {
            origin = segmentStart;
            stampStep = segmentLength / max(divisions, 1.0);
            first = 1.0;                            // interior division points only
            last = divisions - 1.0;
        } else if (divisions > 0.0) {
            origin = segmentStart + halfStamp;      // first stamp touches the start vertex
            stampStep = available / divisions;      // last one touches the end vertex
            first = 0.0;
            last = divisions;
        } else {
            origin = 0.5 * (segmentStart + segmentEnd);   // room for one stamp at most: centre it
            first = 0.0;
            last = available >= 0.0 ? 0.0 : -1.0;
        }
    }

    float t = materialInput.st.t;
    // Explicit mip level: u jumps between stamps, which would break derivative-based selection.
    // One stamp spans stampPixels CSS pixels, i.e. stampPixels * czm_pixelRatio device pixels.
    float lod = max(log2(imageSize.x / (stampPixels * czm_pixelRatio)), 0.0);
    vec4 edge = textureLod(image, vec2(0.0, t), lod);
    vec4 tex = edge;

    // The nearest stamp replaces the edge column (its own u may be outside 0..1, giving the
    // gap); with spacing < 1 neighbours overlap this fragment too and are layered on top
    // ("over" on effectively premultiplied samples: transparent texels are black). Two
    // neighbours per side cover every spacing >= MIN_SPACING.
    if (!wedge && first <= last) {
        float nearest = clamp(floor((d - origin) / stampStep + 0.5), first, last);
        for (int j = -2; j <= 2; j++) {
            float i = nearest + float(j);
            if (i < first || i > last) {
                continue;
            }
            float center = origin + i * stampStep;
            float u = 0.5 + (d - center) / stampMeters;
            if (j != 0 && (u <= 0.0 || u >= 1.0)) {
                continue;
            }
            float keep = stampKeep(i, center, fadeOut, halfStamp, segmentStart, segmentEnd,
                                   precise, preciseVertices);
            vec4 stamp = textureLod(image, vec2(u, t), lod);
            if (j == 0) {
                tex = mix(edge, stamp, keep);
            } else {
                stamp *= keep;
                tex = stamp + tex * (1.0 - stamp.a);
            }
        }
    }

    // CORNER mode: the stamp's symbol centred on the nearest interior vertex, in that corner's
    // own frame (from the fragment's eye position, so it also covers the mitered wedge).
    if (vertexMode == MODE_CORNER) {
        vec4 corner = nearCorner;
        vec3 axisX = nearCornerX.xyz;
        vec3 axisY = nearCornerY.xyz;
        if (!precise) {
            corner = vec4(0.0);
            if (vertexCount >= 2.0 && textureSize(cornerFrames, 0) == ivec2(int(vertexCount), 3)) {
                int v = abs(d - vertexDistanceAt(segment)) <= abs(d - vertexDistanceAt(segment + 1))
                    ? segment : segment + 1;
                corner = texelFetch(cornerFrames, ivec2(v, 0), 0);
                axisX = texelFetch(cornerFrames, ivec2(v, 1), 0).xyz;
                axisY = texelFetch(cornerFrames, ivec2(v, 2), 0).xyz;
            }
        }
        if (corner.w > 0.5) {
            vec3 offset = eyeCoordinate.xyz - corner.xyz;
            float cu = 0.5 + dot(offset, axisX) / stampMeters;
            float cv = 0.5 + dot(offset, axisY) / (v_width * metersPerPixel);
            if (cu > 0.0 && cu < 1.0 && cv > 0.0 && cv < 1.0) {
                // Only the symbol: subtract the stamp's own line (its edge column), which would
                // otherwise draw a short line along the corner's mean direction.
                vec4 symbol = max(textureLod(image, vec2(cu, cv), lod)
                    - textureLod(image, vec2(0.0, cv), lod), 0.0);
                tex = symbol + tex * (1.0 - symbol.a);
            }
        }
    }

    // Un-premultiply: filtering blends in the black of transparent texels.
    tex.rgb = min(tex.rgb / max(tex.a, 0.0001), 1.0);
    vec4 fragColor = tex * color;
    if (fragColor.a < 0.005) {
        discard;
    }

    fragColor = czm_gammaCorrect(fragColor);
    material.emission = fragColor.rgb;
    material.alpha = fragColor.a;
    return material;
}
`;

// st.s is used until its step size (lineLength * 2^-24) reaches 1/64 of a pixel.
const PRECISE_STEP_FRACTION = 64;
// Smallest supported spacing multiplier; keep in sync with MIN_SPACING in the shader.
const MIN_SPACING = 0.25;
const REFINE_ITERATIONS = 3;

/**
 * How stamps behave at vertices (corners and the line's two ends).
 * @enum {number}
 */
const VertexMode = Object.freeze({
  /** Global stamp grid; stamps that would overlap a vertex are left out. */
  SKIP: 0,
  /** Global stamp grid; stamps run up to the vertex and are cut off there. */
  CLIP: 1,
  /** Stamps at evenly divided points of each segment; vertex gaps equal the interior spacing. */
  SNAP: 2,
  /** Per segment, the first and last stamp touch the vertices (shift slightly while zooming). */
  FIT: 3,
  /** SKIP plus the stamp's symbol centred on every interior vertex. */
  CORNER: 4,
});

/**
 * Material that repeats an image stamp along a ground-clamped polyline. It must be rendered
 * with GroundPolylinePrimitive + GroundPolylineGeometry + PolylineMaterialAppearance: the shader
 * relies on that primitive's st.s (arc length along the whole line), its line width varying
 * (v_width) and Cesium's globe depth texture.
 *
 * The image is one stamp, drawn undistorted across the line width, so its on-screen length is
 * lineWidth * imageWidth / imageHeight. Stamps keep that pixel size at any zoom but are anchored
 * to the line; their spacing adapts with zoom in powers of two (1x-2x the repeat length).
 *
 * Call {@link PolylinePatternMaterial.setPositions} whenever the positions or width change and
 * {@link PolylinePatternMaterial.updateCamera} every frame (e.g. from scene.preRender).
 */
export default class PolylinePatternMaterial {
  static TYPE = "PolylinePatternWorld";
  static VertexMode = VertexMode;

  /**
   * @param {object} options
   * @param {string|HTMLImageElement|HTMLCanvasElement} options.image Stamp image (URL or element).
   *   One repeat of the pattern; pad it to build spacing into the image itself.
   * @param {Color} [options.color=Color.WHITE] Tint multiplied with the image.
   * @param {number} [options.spacing=1] Distance between stamps as a multiple of the stamp
   *   length (1 = touching). Values above 1 add plain line (the image's edge column) between
   *   stamps; values down to 0.25 overlap stamps, layered over each other. The stamp itself is
   *   never stretched. Can be changed later via `material.uniforms.spacing`.
   * @param {VertexMode} [options.vertexMode=VertexMode.SKIP] How stamps behave at vertices. Can
   *   be changed later via `material.uniforms.vertexMode`.
   * @returns {Material}
   */
  static create({ image, color = Color.WHITE, spacing = 1, vertexMode = VertexMode.SKIP }) {
    const material = new Material({
      fabric: {
        type: PolylinePatternMaterial.TYPE,
        uniforms: {
          image,
          color,
          spacing,
          vertexMode,
          lineLength: 1,
          preciseMetersPerPixel: 0,
          referenceA: new Cartesian4(),
          tangentA: new Cartesian4(),
          referenceB: new Cartesian4(),
          tangentB: new Cartesian4(),
          rangeA: new Cartesian2(),
          rangeB: new Cartesian2(),
          vertexDistances: Material.DefaultImageId, // replaced by data textures, see below
          vertexCount: 0,
          cornerFrames: Material.DefaultImageId,
          nearCorner: new Cartesian4(),
          nearCornerX: new Cartesian4(),
          nearCornerY: new Cartesian4(),
        },
        source,
      },
      translucent: true,
    });
    material.segments = [];
    material.corners = []; // per vertex: { position, axisX, axisY, interior } (world space)
    material.pendingVertexDistances = undefined;
    material.pendingCornerFrames = undefined;
    // CPU copies of what the shader derives itself; used for the close-zoom precision math.
    material.lineWidth = 1;
    material.imageAspect = imageAspect(image);

    // Data textures need the WebGL context, which Material only gets in update.
    const originalUpdate = material.update.bind(material);
    material.update = function (context) {
      const uniforms = material.uniforms;
      if (material.pendingVertexDistances) {
        const distances = material.pendingVertexDistances;
        uniforms.vertexDistances = createDataTexture(context, distances.length, 1, (data) => {
          distances.forEach((distance, i) => {
            data[i * 4] = distance;
          });
        });
        uniforms.vertexCount = distances.length;
        material.pendingVertexDistances = undefined;
      }
      if (material.pendingCornerFrames) {
        const { width, data } = material.pendingCornerFrames;
        const texture = uniforms.cornerFrames;
        if (texture instanceof Texture && texture.width === width && texture.height === 3) {
          texture.copyFrom({ source: { width, height: 3, arrayBufferView: data } });
        } else {
          uniforms.cornerFrames = createDataTexture(context, width, 3, (target) => target.set(data));
        }
        material.pendingCornerFrames = undefined;
      }
      originalUpdate(context);
      // Once the image has loaded (e.g. from a URL), take its aspect ratio from the texture.
      // Relies on the private Material._textures, like mipmapTexture.
      const texture = material._textures.image;
      if (texture && texture !== context.defaultTexture && texture.height > 0) {
        material.imageAspect = texture.width / texture.height;
      }
    };

    return mipmapTexture(material, "image", {
      wrapS: TextureWrap.CLAMP_TO_EDGE,
      wrapT: TextureWrap.CLAMP_TO_EDGE,
    });
  }

  /**
   * Sets the polyline's positions: computes its geodesic length, which matches the arc length
   * GroundPolylineGeometry normalizes st.s by (stamps are sized in meters from it, so an
   * inaccurate value would stretch them), and caches the segments for updateCamera.
   *
   * @param {Material} material
   * @param {Cartesian3[]} positions
   * @param {number} width The line width in pixels, as given to GroundPolylineGeometry. The
   *   shader reads the width itself; this copy only sizes the close-zoom precision math.
   */
  static setPositions(material, positions, width) {
    material.lineWidth = width;
    const ellipsoid = Ellipsoid.WGS84;
    material.segments = [];
    let start = 0;
    for (let i = 1; i < positions.length; i++) {
      const geodesic = new EllipsoidGeodesic(
        ellipsoid.cartesianToCartographic(positions[i - 1]),
        ellipsoid.cartesianToCartographic(positions[i]),
        ellipsoid,
      );
      const length = geodesic.surfaceDistance;
      if (!(length > 0)) {
        continue;
      }
      material.segments.push({
        geodesic,
        length,
        start,
        a: Cartesian3.normalize(positions[i - 1], new Cartesian3()),
        b: Cartesian3.normalize(positions[i], new Cartesian3()),
      });
      start += length;
    }
    material.uniforms.lineLength = Math.max(start, 1e-3);

    // Distance along the line of every vertex (both ends included), uploaded on next update.
    const distances = [0];
    for (const segment of material.segments) {
      distances.push(segment.start + segment.length);
    }
    material.pendingVertexDistances = distances;
    material.corners = computeCorners(material.segments);
  }

  /**
   * Updates the camera-dependent uniforms (close-range reference points and, in CORNER mode,
   * the corner frames), in double precision.
   *
   * @param {Material} material
   * @param {Camera} camera
   */
  static updateCamera(material, camera) {
    const uniforms = material.uniforms;
    const step = uniforms.lineLength * 2 ** -24;
    uniforms.preciseMetersPerPixel = step * PRECISE_STEP_FRACTION;
    // Stamp spacing is at most 2 repeat lengths; keep the modulus a multiple of twice that so
    // the stamp index parity (every-second-stamp fade) is preserved. Pixels here are CSS pixels,
    // like the shader's metersPerPixel.
    const repeatPixels =
      material.lineWidth * material.imageAspect * Math.max(uniforms.spacing, MIN_SPACING);
    const maxSpacing = 2 * repeatPixels * uniforms.preciseMetersPerPixel;
    const modulus = 2 ** Math.ceil(Math.log2(Math.max(2 * maxSpacing, 1e-3)));

    // The two segments closest to the camera (two, so corners near the camera work).
    const cameraPosition = camera.positionWC;
    let first;
    let second;
    for (const segment of material.segments) {
      const nearest = nearestPointOnSegment(segment, cameraPosition);
      const candidate = { segment, ...nearest };
      if (!first || candidate.distance < first.distance) {
        second = first;
        first = candidate;
      } else if (!second || candidate.distance < second.distance) {
        second = candidate;
      }
    }
    setReference(uniforms.referenceA, uniforms.tangentA, uniforms.rangeA, first, camera, modulus);
    setReference(uniforms.referenceB, uniforms.tangentB, uniforms.rangeB, second, camera, modulus);

    if (uniforms.vertexMode === VertexMode.CORNER) {
      updateCornerFrames(material, camera);
    } else {
      uniforms.nearCorner.w = 0;
    }
  }
}

const scratchCartographic = new Cartographic();
const scratchCameraUnit = new Cartesian3();
const scratchNormal = new Cartesian3();
const scratchProjected = new Cartesian3();
const scratchCross = new Cartesian3();
const scratchBefore = new Cartesian3();
const scratchAfter = new Cartesian3();
const scratchToCamera = new Cartesian3();

function pointAt(segment, fraction, result) {
  const cartographic = segment.geodesic.interpolateUsingFraction(
    Math.min(Math.max(fraction, 0), 1),
    scratchCartographic,
  );
  cartographic.height = 0;
  return Ellipsoid.WGS84.cartographicToCartesian(cartographic, result);
}

/** Unit direction of travel along a segment at the given fraction. */
function directionAt(segment, fraction, result) {
  const delta = Math.min(1 / segment.length, 0.5); // ~1 m
  const before = pointAt(segment, Math.max(fraction - delta, 0), scratchBefore);
  const after = pointAt(segment, Math.min(fraction + delta, 1), scratchAfter);
  return Cartesian3.normalize(Cartesian3.subtract(after, before, result), result);
}

/** Closest point on a geodesic segment to `position`, with the line direction there. */
function nearestPointOnSegment(segment, position) {
  // Start from the great-circle solution, then refine on the actual ellipsoid geodesic.
  const c = Cartesian3.normalize(position, scratchCameraUnit);
  const normal = Cartesian3.normalize(
    Cartesian3.cross(segment.a, segment.b, scratchNormal),
    scratchNormal,
  );
  const projected = Cartesian3.subtract(
    c,
    Cartesian3.multiplyByScalar(normal, Cartesian3.dot(c, normal), scratchProjected),
    scratchProjected,
  );
  const angle = Math.atan2(
    Cartesian3.dot(Cartesian3.cross(segment.a, projected, scratchCross), normal),
    Cartesian3.dot(segment.a, projected),
  );
  const segmentAngle = Cartesian3.angleBetween(segment.a, segment.b);
  let fraction = segmentAngle > 0 ? Math.min(Math.max(angle / segmentAngle, 0), 1) : 0;

  const point = new Cartesian3();
  const tangent = new Cartesian3();
  for (let i = 0; i <= REFINE_ITERATIONS; i++) {
    pointAt(segment, fraction, point);
    directionAt(segment, fraction, tangent);
    if (i === REFINE_ITERATIONS) {
      break;
    }
    const along = Cartesian3.dot(Cartesian3.subtract(position, point, scratchToCamera), tangent);
    fraction = Math.min(Math.max(fraction + along / segment.length, 0), 1);
  }
  return {
    point,
    tangent,
    fraction,
    distance: Cartesian3.distance(position, point),
  };
}

const scratchEye = new Cartesian3();

function setReference(reference, tangent, range, nearest, camera, modulus) {
  if (!nearest) {
    tangent.w = 0;
    return;
  }
  // Distance from the reference point back to its segment's start and on to its end.
  range.x = -nearest.fraction * nearest.segment.length;
  range.y = (1 - nearest.fraction) * nearest.segment.length;
  const view = camera.viewMatrix;
  const eye = Matrix4.multiplyByPoint(view, nearest.point, scratchEye);
  const distanceAlong = nearest.segment.start + nearest.fraction * nearest.segment.length;
  Cartesian4.fromElements(eye.x, eye.y, eye.z, distanceAlong % modulus, reference);
  const direction = Matrix4.multiplyByPointAsVector(view, nearest.tangent, scratchEye);
  Cartesian3.normalize(direction, direction);
  Cartesian4.fromElements(direction.x, direction.y, direction.z, 1, tangent);
}

const scratchIncoming = new Cartesian3();
const scratchOutgoing = new Cartesian3();
const scratchUp = new Cartesian3();

/**
 * World-space frame of every vertex for CORNER mode: the symbol's x axis is the corner's mean
 * direction of travel, y lies across it on the ground. Only interior vertices get a symbol.
 */
function computeCorners(segments) {
  if (segments.length === 0) {
    return [];
  }
  const corners = [];
  for (let i = 0; i <= segments.length; i++) {
    const interior = i > 0 && i < segments.length;
    const position = interior || i === 0
      ? pointAt(segments[Math.min(i, segments.length - 1)], 0, new Cartesian3())
      : pointAt(segments[i - 1], 1, new Cartesian3());
    const axisX = new Cartesian3();
    if (interior) {
      const incoming = directionAt(segments[i - 1], 1, scratchIncoming);
      const outgoing = directionAt(segments[i], 0, scratchOutgoing);
      Cartesian3.add(incoming, outgoing, axisX);
      if (Cartesian3.magnitude(axisX) < 1e-6) {
        Cartesian3.clone(incoming, axisX); // the line doubles back: use the incoming direction
      }
      Cartesian3.normalize(axisX, axisX);
    }
    const up = Ellipsoid.WGS84.geodeticSurfaceNormal(position, scratchUp);
    const axisY = interior
      ? Cartesian3.normalize(Cartesian3.cross(up, axisX, new Cartesian3()), new Cartesian3())
      : new Cartesian3();
    corners.push({ position, axisX, axisY, interior });
  }
  return corners;
}

const scratchCornerEye = new Cartesian3();
const scratchCornerAxis = new Cartesian3();

/** Uploads every corner's frame in eye coordinates and picks the corner nearest the camera. */
function updateCornerFrames(material, camera) {
  const uniforms = material.uniforms;
  const corners = material.corners;
  const width = corners.length;
  uniforms.nearCorner.w = 0;
  if (width === 0) {
    return;
  }
  const view = camera.viewMatrix;
  let data = material.cornerFrameData;
  if (!data || data.length !== width * 3 * 4) {
    data = material.cornerFrameData = new Float32Array(width * 3 * 4);
  }
  let nearestDistance = Infinity;
  corners.forEach((corner, v) => {
    const eye = Matrix4.multiplyByPoint(view, corner.position, scratchCornerEye);
    data.set([eye.x, eye.y, eye.z, corner.interior ? 1 : 0], v * 4);
    const axisX = Matrix4.multiplyByPointAsVector(view, corner.axisX, scratchCornerAxis);
    data.set([axisX.x, axisX.y, axisX.z, 0], (width + v) * 4);
    const axisXCopy = Cartesian3.clone(axisX, new Cartesian3());
    const axisY = Matrix4.multiplyByPointAsVector(view, corner.axisY, scratchCornerAxis);
    data.set([axisY.x, axisY.y, axisY.z, 0], (2 * width + v) * 4);

    const distance = Cartesian3.magnitude(eye); // camera is the eye-space origin
    if (corner.interior && distance < nearestDistance) {
      nearestDistance = distance;
      Cartesian4.fromElements(eye.x, eye.y, eye.z, 1, uniforms.nearCorner);
      Cartesian4.fromElements(axisXCopy.x, axisXCopy.y, axisXCopy.z, 0, uniforms.nearCornerX);
      Cartesian4.fromElements(axisY.x, axisY.y, axisY.z, 0, uniforms.nearCornerY);
    }
  });
  material.pendingCornerFrames = { width, data };
}

/** Width / height of an image element or canvas; 1 until a URL image has loaded. */
function imageAspect(image) {
  const width = image?.naturalWidth || image?.width;
  const height = image?.naturalHeight || image?.height;
  return width > 0 && height > 0 ? width / height : 1;
}

/** A width x height RGBA float texture, filled by `fill(data)`; sampled with texelFetch. */
function createDataTexture(context, width, height, fill) {
  const data = new Float32Array(width * height * 4);
  fill(data);
  return new Texture({
    context,
    width,
    height,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: PixelDatatype.FLOAT,
    flipY: false,
    source: { width, height, arrayBufferView: data },
    sampler: new Sampler({
      wrapS: TextureWrap.CLAMP_TO_EDGE,
      wrapT: TextureWrap.CLAMP_TO_EDGE,
      minificationFilter: TextureMinificationFilter.NEAREST,
      magnificationFilter: TextureMagnificationFilter.NEAREST,
    }),
  });
}
