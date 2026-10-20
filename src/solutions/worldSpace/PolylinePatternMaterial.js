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
import { sizeScale } from "../../shared/maxHeight.js";
import mipmapTexture from "../../shared/mipmapTexture.js";
import {
  createZoomSettle,
  referenceMetersPerPixel,
  updateZoomSettle,
} from "../../shared/zoomSettle.js";

// Intended for GroundPolylinePrimitive, whose fragment shader provides st.s as arc length
// along the whole line normalized to 0..1, and st.t as 0..1 across the line width.
//
// Two optional layers, both drawn as tall as the line is wide (so each image keeps its aspect
// ratio: one image = lineWidth * imageWidth / imageHeight pixels along the line):
//
//  - Line image: a seamless pattern (solid, dashed, wave, sawtooth ...) repeated along the
//    line, anchored to the ground and to the start of the line, like the stamps: the period is
//    2^k meters, k chosen per fragment so it is 1x-2x the image's natural length, so it only
//    stretches with zoom, never when a vertex moves (near a power-of-two step the two periods
//    cross-fade briefly). The pattern runs on across vertices. In the mitered wedge outside a
//    corner, GroundPolylinePrimitive clamps st.s to the vertex, so the wedge shows the image
//    column at the vertex, extended until the two segments meet at the miter.
//
//  - Stamp image: a symbol on a transparent background, drawn on top at a near-constant pixel
//    size and anchored to the line. Stamp spacing is 2^k meters, k chosen per fragment so it is
//    1x-2x the repeat length (stamp length * `spacing`); every second stamp fades out as the
//    spacing approaches the next power of two, so nothing pops while zooming. A stamp belongs
//    to the segment containing its centre and is drawn in that segment's frame, also where it
//    reaches past a vertex: near a vertex the stamps of both segments meeting there are drawn
//    from per-vertex frames (eye-space position, incoming / outgoing direction, up) uploaded by
//    the CPU every frame, so a stamp over a corner is whole, not torn. It can only show inside
//    the line's footprint (the draped bands plus the corner wedges). The stamp grid starts at
//    the first vertex (the first stamp touches it) and runs up to the last vertex, which cuts
//    off the final stamp; moving the last vertex can make the line finish with a whole stamp.
//
// Max camera height: above it (sizeScale < 1, see maxHeight.js) both layers keep their ground
// size instead of their on-screen size. The geometry stays v_width pixels wide (rebuilding it
// every frame would be costly), so the pattern is drawn in a centred band v_width * sizeScale
// pixels wide and the line looks thinner, like paint on the ground.
//
// Precision: st.s is a float32 fraction of the whole line, so distance along the line is only
// resolved to lineLength * 2^-24 (22 cm on a 3,600 km line). Zoomed in close, stamps would
// smear and vanish. Where that step size matters (metersPerPixel < preciseMetersPerPixel), the
// distance is instead measured in eye space from reference points on the line near the camera,
// computed every frame on the CPU in double precision (see updateCamera). Their distances along
// the line are passed modulo a power of two larger than any stamp spacing or line period used
// there, so stamp positions, the every-second-stamp fade and the line phase stay consistent. (The GLSL lives in a JS template
// string: never put a backtick in a shader comment.)
const source = /* glsl */ `
in float v_width;               // line width in pixels, provided by GroundPolylinePrimitive

const float MIN_SPACING = 0.25; // below 1, stamps overlap; see stampsAt

uniform sampler2D lineImage;    // 1x1 placeholder = no line layer (null, or still loading)
uniform sampler2D stampImage;   // 1x1 placeholder = no stamps
uniform vec4 lineColor;
uniform vec4 stampColor;
uniform float spacing;          // stamp repeat as a multiple of the stamp length (>= 0.25)
// Zoom level shifts (log2 units) that keep the fades from resting half faded; see zoomSettle.
uniform float lineShift;
uniform float stampShift;
uniform float sizeScale;        // < 1 above the max camera height (pattern keeps its ground size)
uniform float lineLength;
uniform float preciseMetersPerPixel;
uniform vec4 referenceA;        // xyz: point on the line (eye coords), w: distance mod modulus
uniform vec4 tangentA;          // xyz: line direction there (eye coords), w: 1 if valid
uniform vec4 referenceB;        // same for the second-nearest segment (corners)
uniform vec4 tangentB;
uniform vec2 rangeA;            // distance along the line from referenceA to its segment's ends
uniform vec2 rangeB;
uniform vec2 lineEndsA;         // referenceA's segment: x = 1 if it starts the line, y = 1 if it ends it
uniform vec2 lineEndsB;
uniform sampler2D vertexDistances;  // r: distance along the line of each vertex, ascending
uniform float vertexCount;
// Per vertex (texel x = vertex index), eye coordinates: row 0 = position (w: 1 if interior),
// row 1 = incoming direction, row 2 = outgoing direction, row 3 = up.
uniform sampler2D vertexFrames;
// Close-zoom path: the interior vertex nearest the camera, eye coordinates.
// nearVertex.w: 0 = none, else 1 + 2 if the segment before starts the line + 4 if the segment
// after ends the line.
uniform vec4 nearVertex;        // xyz: position, w: see above
uniform vec4 nearIncoming;      // xyz: incoming direction, w: length of the segment before
uniform vec4 nearOutgoing;      // xyz: outgoing direction, w: length of the segment after
uniform vec4 nearUp;            // xyz: up, w: the vertex's distance along the line mod modulus

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

// A filtered sample, fringe-free (transparent texels are black and filtering blends that into
// edges), tinted and premultiplied.
vec4 tinted(vec4 s, vec4 tint)
{
    s.rgb = min(s.rgb / max(s.a, 0.0001), 1.0) * s.a;
    return vec4(s.rgb * tint.rgb, s.a) * tint.a;
}

vec4 over(vec4 top, vec4 bottom)
{
    return top + bottom * (1.0 - top.a);
}

// The line layer at "along" meters along the line, "t" across it, for a band "widthPixels" wide.
vec4 lineAt(float along, float t, float widthPixels, float metersPerPixel)
{
    if (t <= 0.0 || t >= 1.0) {
        return vec4(0.0);
    }
    vec2 imageSize = vec2(textureSize(lineImage, 0));
    float natural = widthPixels * imageSize.x / imageSize.y * metersPerPixel;  // one period, meters
    // A power-of-two period in meters (1x-2x natural), anchored at the line start: it depends
    // only on zoom, and each level's pattern nests in the next. Just before the period doubles
    // it is nearly 2x stretched; cross-fade to half the period there.
    float level = log2(natural) + lineShift;
    float k = ceil(level);
    float blend = smoothstep(0.8, 1.0, k - level);  // partly faded for fract(level) in 0..0.2
    float period = exp2(k);
    float phase = along / period;
    float lod = max(log2(imageSize.x * metersPerPixel / (period * czm_pixelRatio)), 0.0);
    vec4 coarse = textureLod(lineImage, vec2(fract(phase), t), lod);
    vec4 fine = textureLod(lineImage, vec2(fract(2.0 * phase), t), lod + 1.0);
    return tinted(mix(coarse, fine, blend), lineColor);
}

// The stamps of the segment [a, b] at "along" meters along the line, "t" across it.
// lineEnds: x = 1 if the segment starts the line, y = 1 if it ends it (nothing is drawn beyond
// those, so stamps can't reach past them).
vec4 stampsAt(float along, float t, float a, float b, vec2 lineEnds, float gridSpacing,
              float fadeOut, float stampMeters, float lod)
{
    vec4 result = vec4(0.0);
    if (t <= 0.0 || t >= 1.0) {
        return result;
    }
    // Stamp centres: origin + i * gridSpacing. The grid is anchored so the first stamp's leading
    // edge touches the start of the line (distance 0, which is also 0 modulo the close-zoom
    // modulus); the stamps shift together by up to half a stamp as the stamp's ground length
    // changes with zoom. The segment owns the stamps whose centre lies in [a, b).
    float halfStamp = 0.5 * stampMeters;
    float origin = halfStamp;
    float first = ceil((a - origin) / gridSpacing);
    float last = ceil((b - origin) / gridSpacing) - 1.0;
    if (lineEnds.y > 0.5) {
        // The line's last segment also owns the stamps that start before its end but are
        // centred beyond it, so the pattern runs all the way to the last vertex, which cuts the
        // final stamp off (nothing is drawn past the end of the line).
        last = ceil((b + halfStamp - origin) / gridSpacing) - 1.0;
    }
    if (first > last) {
        return result;
    }
    // The nearest stamp and, for spacing < 1 where stamps overlap, two neighbours either side.
    float nearest = clamp(floor((along - origin) / gridSpacing + 0.5), first, last);
    for (int j = -2; j <= 2; j++) {
        float i = nearest + float(j);
        if (i < first || i > last) {
            continue;
        }
        float center = origin + i * gridSpacing;
        float u = 0.5 + (along - center) / stampMeters;
        if (u <= 0.0 || u >= 1.0) {
            continue;
        }
        // Every second stamp fades out as the spacing level approaches the next power of two.
        float keep = mod(i, 2.0) < 0.5 ? 1.0 : 1.0 - fadeOut;
        // Stamps may reach past an interior vertex (the next segment draws the rest) and are cut
        // off at the last vertex, but must not overhang the first one: with spacing < 1 the grid
        // has stamps before its first whole one. A stamp exactly touching the start is kept
        // whole; one overhanging fades out over a tenth of a half stamp.
        float startGap = lineEnds.x > 0.5 ? center - a : 1e30;
        keep *= smoothstep(0.9 * halfStamp, halfStamp, startGap);
        if (keep > 0.0) {
            result = over(tinted(textureLod(stampImage, vec2(u, t), lod), stampColor) * keep, result);
        }
    }
    return result;
}

czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);

    // A layer whose image is null or still loading is bound to Cesium's 1x1 placeholder.
    bool hasLine = textureSize(lineImage, 0).x > 1;
    bool hasStamp = textureSize(stampImage, 0).x > 1;
    if (!hasLine && !hasStamp) {
        discard;
    }

    float d = materialInput.st.s * lineLength;     // meters along the line

    // Pixel size on the ground at this fragment, computed the same way GroundPolylinePrimitive
    // sizes the line width (from the globe depth). Screen-space derivatives of d would be
    // noisy, because d itself is reconstructed from depth. Meters per CSS pixel (it includes
    // the pixel ratio), the same units as v_width.
    float depth = czm_unpackDepth(texture(czm_globeDepthTexture, gl_FragCoord.xy / czm_viewport.zw));
    vec4 eyeCoordinate = czm_windowToEyeCoordinates(gl_FragCoord.xy, depth);
    eyeCoordinate /= eyeCoordinate.w;
    float metersPerPixel = max(czm_metersPerPixel(eyeCoordinate), 1e-6);
    // Above the max camera height (sizeScale < 1) the pattern keeps its ground size: it is drawn
    // in a band v_width * sizeScale pixels wide, centred in the geometry's v_width band. Below
    // one pixel the band stays one pixel wide and fades with its coverage instead of aliasing.
    float bandPixels = min(max(v_width * sizeScale, 1.0), v_width);
    float coverage = v_width * sizeScale / bandPixels;
    float width = bandPixels * metersPerPixel;     // pattern band width on the ground, meters

    // Zoomed in close: measure along the line from the nearest reference point instead.
    bool precise = false;
    vec2 preciseVertices = vec2(0.0);   // the chosen segment's two ends, same units as d
    vec2 preciseLineEnds = vec2(0.0);
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
        preciseLineEnds = useA ? lineEndsA : lineEndsB;
    }

    // The segment this fragment is on.
    float segmentStart = 0.0;
    float segmentEnd = lineLength;
    vec2 lineEnds = vec2(1.0);
    int segment = 0;
    if (precise) {
        segmentStart = preciseVertices.x;
        segmentEnd = preciseVertices.y;
        lineEnds = preciseLineEnds;
    } else if (vertexCount >= 2.0) {
        segment = segmentIndex(d);
        segmentStart = vertexDistanceAt(segment);
        segmentEnd = vertexDistanceAt(segment + 1);
        lineEnds = vec2(segment == 0 ? 1.0 : 0.0, segment + 2 >= int(vertexCount) ? 1.0 : 0.0);
    }
    float t = (materialInput.st.t - 0.5) * v_width / bandPixels + 0.5;

    vec4 result = vec4(0.0);
    if (hasLine) {
        result = lineAt(clamp(d, segmentStart, segmentEnd), t, bandPixels, metersPerPixel);
    }

    if (hasStamp) {
        vec2 stampSize = vec2(textureSize(stampImage, 0));
        float stampMeters = width * stampSize.x / stampSize.y;
        float repeatMeters = stampMeters * max(spacing, MIN_SPACING);
        float level = log2(repeatMeters) + stampShift;    // 2^level m ~ one repeat on screen
        float k = ceil(level);
        float gridSpacing = exp2(k);                      // ~1x..2x the repeat length
        // Every second stamp fades out over the last 10% of the level before the spacing doubles
        // (fract(level) in 0.9..1): short, and the level shift moves a resting camera out of it.
        float fadeOut = smoothstep(0.9, 1.0, 1.0 - (k - level));
        // Explicit mip level (u jumps between stamps): one stamp spans this many device pixels.
        float lod = max(log2(stampSize.x * metersPerPixel / (stampMeters * czm_pixelRatio)), 0.0);

        // The nearest interior vertex, with its position and directions (eye coordinates).
        bool haveVertex = false;
        vec3 vertexPosition = vec3(0.0);
        vec3 incoming = vec3(1.0, 0.0, 0.0);
        vec3 outgoing = vec3(1.0, 0.0, 0.0);
        vec3 up = vec3(0.0, 0.0, 1.0);
        float dv = 0.0;
        float lengthBefore = 0.0;
        float lengthAfter = 0.0;
        bool beforeStartsLine = false;   // the segment before the vertex is the line's first
        bool afterEndsLine = false;      // the segment after the vertex is the line's last
        if (precise) {
            if (nearVertex.w > 0.5) {
                haveVertex = true;
                beforeStartsLine = mod(floor(nearVertex.w / 2.0), 2.0) > 0.5;
                afterEndsLine = mod(floor(nearVertex.w / 4.0), 2.0) > 0.5;
                vertexPosition = nearVertex.xyz;
                incoming = nearIncoming.xyz;
                outgoing = nearOutgoing.xyz;
                up = nearUp.xyz;
                dv = nearUp.w;
                lengthBefore = nearIncoming.w;
                lengthAfter = nearOutgoing.w;
            }
        } else if (vertexCount >= 2.0 && textureSize(vertexFrames, 0) == ivec2(int(vertexCount), 4)) {
            int v = abs(d - vertexDistanceAt(segment)) <= abs(d - vertexDistanceAt(segment + 1))
                ? segment : segment + 1;
            vec4 frame = texelFetch(vertexFrames, ivec2(v, 0), 0);
            if (frame.w > 0.5) {
                haveVertex = true;
                vertexPosition = frame.xyz;
                incoming = texelFetch(vertexFrames, ivec2(v, 1), 0).xyz;
                outgoing = texelFetch(vertexFrames, ivec2(v, 2), 0).xyz;
                up = texelFetch(vertexFrames, ivec2(v, 3), 0).xyz;
                dv = vertexDistanceAt(v);
                lengthBefore = dv - vertexDistanceAt(v - 1);
                lengthAfter = vertexDistanceAt(v + 1) - dv;
                beforeStartsLine = v == 1;
                afterEndsLine = v + 2 >= int(vertexCount);
            }
        }
        // Past the vertex along this fragment's own segment (the corner's mitered wedge, and the
        // part of the band beyond the vertex), GroundPolylinePrimitive clamps st.s to the vertex,
        // so d can't place stamps there. Tested exactly per pixel from the fragment's position;
        // a screen-space test of st.s changing would misclassify 2x2 pixel quads at the edge.
        vec3 offset = eyeCoordinate.xyz - vertexPosition;
        bool vertexAtEnd = abs(dv - segmentEnd) <= abs(dv - segmentStart);
        bool pastOwnEnd = haveVertex
            && (vertexAtEnd ? dot(offset, incoming) > 0.0 : dot(offset, outgoing) < 0.0);

        // This segment's stamps, measured along the line.
        if (!pastOwnEnd) {
            result = over(stampsAt(d, t, segmentStart, segmentEnd, lineEnds, gridSpacing,
                                   fadeOut, stampMeters, lod), result);
        }

        // Near an interior vertex: stamps reaching across it, measured in their own segment's
        // frame from the vertex position and directions. That adds the other segment's stamps
        // and, past the vertex, this segment's too.
        float reach = 0.5 * stampMeters + width;
        if (haveVertex && (pastOwnEnd || abs(d - dv) < reach)) {
            if (pastOwnEnd || !vertexAtEnd) {
                float along = dv + dot(offset, incoming);
                float across = 0.5 + dot(offset, normalize(cross(incoming, up))) / width;
                result = over(stampsAt(along, across, dv - lengthBefore, dv,
                                       vec2(beforeStartsLine ? 1.0 : 0.0, 0.0), gridSpacing,
                                       fadeOut, stampMeters, lod), result);
            }
            if (pastOwnEnd || vertexAtEnd) {
                float along = dv + dot(offset, outgoing);
                float across = 0.5 + dot(offset, normalize(cross(outgoing, up))) / width;
                result = over(stampsAt(along, across, dv, dv + lengthAfter,
                                       vec2(0.0, afterEndsLine ? 1.0 : 0.0), gridSpacing,
                                       fadeOut, stampMeters, lod), result);
            }
        }
    }

    result *= coverage;
    if (result.a < 0.005) {
        discard;
    }
    vec4 fragColor = czm_gammaCorrect(vec4(result.rgb / result.a, result.a));
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
 * Material that draws a patterned line with optional symbols on top, along a ground-clamped
 * polyline. It must be rendered with GroundPolylinePrimitive + GroundPolylineGeometry +
 * PolylineMaterialAppearance: the shader relies on that primitive's st.s (arc length along the
 * whole line), its line width varying (v_width) and Cesium's globe depth texture.
 *
 * Both images are drawn as tall as the line is wide and keep their aspect ratio, so their
 * on-screen size follows the line width; nothing else configures it.
 *
 * Call {@link PolylinePatternMaterial.setPositions} whenever the positions or width change and
 * {@link PolylinePatternMaterial.updateCamera} every frame (e.g. from scene.preRender).
 */
export default class PolylinePatternMaterial {
  static TYPE = "PolylinePatternWorld";

  /**
   * @param {object} options
   * @param {string|HTMLImageElement|HTMLCanvasElement|null} [options.lineImage=null] One period
   *   of a seamless line pattern (left and right edges must join), repeated along the line.
   *   null = no line.
   * @param {string|HTMLImageElement|HTMLCanvasElement|null} [options.stampImage=null] A symbol on
   *   a transparent background, drawn on top. null = no stamps.
   * @param {Color} [options.lineColor=Color.WHITE] Tint multiplied with the line image.
   * @param {Color} [options.stampColor=Color.WHITE] Tint multiplied with the stamp image.
   * @param {number} [options.spacing=1] Distance between stamps as a multiple of the stamp
   *   length (1 = touching, down to 0.25 = overlapping). Changeable via `material.uniforms.spacing`.
   * @param {number} [options.maxHeight=Infinity] Camera height (meters) above which the pattern,
   *   line thickness included, keeps its ground size instead of its on-screen size. Changeable
   *   via `material.maxHeight`.
   * @param {number} [options.heightTransition=0] Meters below `maxHeight` over which that eases
   *   in. Changeable via `material.heightTransition`.
   * @returns {Material}
   */
  static create({
    lineImage = null,
    stampImage = null,
    lineColor = Color.WHITE,
    stampColor = Color.WHITE,
    spacing = 1,
    maxHeight = Infinity,
    heightTransition = 0,
  } = {}) {
    const material = new Material({
      fabric: {
        type: PolylinePatternMaterial.TYPE,
        uniforms: {
          lineImage: lineImage ?? Material.DefaultImageId,
          stampImage: stampImage ?? Material.DefaultImageId,
          lineColor,
          stampColor,
          spacing,
          lineShift: 0,
          stampShift: 0,
          sizeScale: 1,
          lineLength: 1,
          preciseMetersPerPixel: 0,
          referenceA: new Cartesian4(),
          tangentA: new Cartesian4(),
          referenceB: new Cartesian4(),
          tangentB: new Cartesian4(),
          rangeA: new Cartesian2(),
          rangeB: new Cartesian2(),
          lineEndsA: new Cartesian2(),
          lineEndsB: new Cartesian2(),
          vertexDistances: Material.DefaultImageId, // replaced by data textures, see below
          vertexCount: 0,
          vertexFrames: Material.DefaultImageId,
          nearVertex: new Cartesian4(),
          nearIncoming: new Cartesian4(),
          nearOutgoing: new Cartesian4(),
          nearUp: new Cartesian4(),
        },
        source,
      },
      translucent: true,
    });
    material.segments = [];
    material.vertices = []; // per vertex: { position, incoming, outgoing, up, distance, interior }
    material.pendingVertexDistances = undefined;
    material.pendingVertexFrames = undefined;
    // CPU copies of what the shader derives itself; used for the close-zoom precision math.
    material.lineWidth = 1;
    material.lineAspect = imageAspect(lineImage);
    material.stampAspect = imageAspect(stampImage);
    material.zoomSettle = createZoomSettle();
    material.maxHeight = maxHeight;
    material.heightTransition = heightTransition;

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
      if (material.pendingVertexFrames) {
        const { width, data } = material.pendingVertexFrames;
        const texture = uniforms.vertexFrames;
        if (texture instanceof Texture && texture.width === width && texture.height === 4) {
          texture.copyFrom({ source: { width, height: 4, arrayBufferView: data } });
        } else {
          uniforms.vertexFrames = createDataTexture(context, width, 4, (target) => target.set(data));
        }
        material.pendingVertexFrames = undefined;
      }
      originalUpdate(context);
      // Once an image has loaded (e.g. from a URL), take its aspect ratio from the texture.
      // Relies on the private Material._textures, like mipmapTexture.
      for (const [uniformName, key] of [["lineImage", "lineAspect"], ["stampImage", "stampAspect"]]) {
        const texture = material._textures[uniformName];
        if (texture && texture !== context.defaultTexture && texture.height > 0) {
          material[key] = texture.width / texture.height;
        }
      }
    };

    // The line pattern repeats (fract in the shader, REPEAT so filtering wraps across the seam);
    // stamps never repeat.
    mipmapTexture(material, "lineImage", {
      wrapS: TextureWrap.REPEAT,
      wrapT: TextureWrap.CLAMP_TO_EDGE,
    });
    return mipmapTexture(material, "stampImage", {
      wrapS: TextureWrap.CLAMP_TO_EDGE,
      wrapT: TextureWrap.CLAMP_TO_EDGE,
    });
  }

  /**
   * Changes the images; null removes that layer.
   *
   * @param {Material} material
   * @param {object} images
   * @param {string|HTMLImageElement|HTMLCanvasElement|null} [images.lineImage]
   * @param {string|HTMLImageElement|HTMLCanvasElement|null} [images.stampImage]
   */
  static setImages(material, { lineImage, stampImage } = {}) {
    if (lineImage !== undefined) {
      material.uniforms.lineImage = lineImage ?? Material.DefaultImageId;
      material.lineAspect = imageAspect(lineImage);
    }
    if (stampImage !== undefined) {
      material.uniforms.stampImage = stampImage ?? Material.DefaultImageId;
      material.stampAspect = imageAspect(stampImage);
    }
  }

  /**
   * Sets the polyline's positions: computes its geodesic length, which matches the arc length
   * GroundPolylineGeometry normalizes st.s by (images are sized in meters from it, so an
   * inaccurate value would stretch them), and caches the segments and vertex frames.
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
        index: material.segments.length,
        geodesic,
        length,
        start,
        a: Cartesian3.normalize(positions[i - 1], new Cartesian3()),
        b: Cartesian3.normalize(positions[i], new Cartesian3()),
      });
      start += length;
    }
    material.uniforms.lineLength = Math.max(start, 1e-3);
    material.vertices = computeVertices(material.segments);
    // Distance along the line of every vertex (both ends included), uploaded on next update.
    material.pendingVertexDistances = material.vertices.map((vertex) => vertex.distance);
  }

  /**
   * Updates the camera-dependent uniforms (close-range reference points and the vertex frames,
   * in double precision; the max camera height scale; the zoom fade level shifts). Call every
   * frame: while the fades are settling after the camera height stops changing, it requests
   * further frames itself.
   *
   * @param {Material} material
   * @param {Scene} scene
   */
  static updateCamera(material, scene) {
    const camera = scene.camera;
    const uniforms = material.uniforms;
    uniforms.sizeScale = sizeScale(
      camera.positionCartographic.height,
      material.maxHeight,
      material.heightTransition,
    );

    // Pixels here are CSS pixels, like the shader's metersPerPixel.
    const stampPixels = material.lineWidth * material.stampAspect * Math.max(uniforms.spacing, MIN_SPACING);
    const linePixels = material.lineWidth * material.lineAspect;
    const metersPerPixel = referenceMetersPerPixel(scene) * uniforms.sizeScale;
    const shifts = updateZoomSettle(material.zoomSettle, scene, {
      line: { level: Math.log2(linePixels * metersPerPixel), window: [0, 0.2] },
      stamp: { level: Math.log2(stampPixels * metersPerPixel), window: [0.9, 1] },
    });
    uniforms.lineShift = shifts.line;
    uniforms.stampShift = shifts.stamp;

    const step = uniforms.lineLength * 2 ** -24;
    uniforms.preciseMetersPerPixel = step * PRECISE_STEP_FRACTION;
    // Stamp spacing is under 4 repeat lengths and the line period under 4 image lengths (2x,
    // plus the level shift); keep the modulus a multiple of twice the larger so the stamp index
    // parity (every-second-stamp fade) and the line phase are preserved.
    const repeatPixels = Math.max(stampPixels, linePixels);
    const maxSpacing = 4 * repeatPixels * uniforms.preciseMetersPerPixel;
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
    const segmentCount = material.segments.length;
    setReference(uniforms.referenceA, uniforms.tangentA, uniforms.rangeA, uniforms.lineEndsA,
      first, segmentCount, camera, modulus);
    setReference(uniforms.referenceB, uniforms.tangentB, uniforms.rangeB, uniforms.lineEndsB,
      second, segmentCount, camera, modulus);

    updateVertexFrames(material, camera, modulus);
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

function setReference(reference, tangent, range, lineEnds, nearest, segmentCount, camera, modulus) {
  if (!nearest) {
    tangent.w = 0;
    return;
  }
  // Whether this segment starts / ends the line (stamps can't reach past those).
  lineEnds.x = nearest.segment.index === 0 ? 1 : 0;
  lineEnds.y = nearest.segment.index === segmentCount - 1 ? 1 : 0;
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

/**
 * World-space frame of every vertex: position, distance along the line, direction of travel
 * arriving and leaving, and the ground's up. Only interior vertices join two segments.
 */
function computeVertices(segments) {
  if (segments.length === 0) {
    return [];
  }
  const vertices = [];
  for (let i = 0; i <= segments.length; i++) {
    const before = segments[i - 1];
    const after = segments[i];
    const position = after ? pointAt(after, 0, new Cartesian3()) : pointAt(before, 1, new Cartesian3());
    const incoming = before ? directionAt(before, 1, new Cartesian3()) : undefined;
    const outgoing = after ? directionAt(after, 0, new Cartesian3()) : undefined;
    vertices.push({
      position,
      incoming: incoming ?? outgoing,
      outgoing: outgoing ?? incoming,
      up: Ellipsoid.WGS84.geodeticSurfaceNormal(position, new Cartesian3()),
      distance: after ? after.start : before.start + before.length,
      interior: Boolean(before && after),
    });
  }
  return vertices;
}

const scratchVertexEye = new Cartesian3();

/**
 * Uploads every vertex frame in eye coordinates (rows: position, incoming, outgoing, up) and
 * sets the close-zoom uniforms for the interior vertex nearest the camera.
 */
function updateVertexFrames(material, camera, modulus) {
  const uniforms = material.uniforms;
  const vertices = material.vertices;
  const width = vertices.length;
  uniforms.nearVertex.w = 0;
  if (width === 0) {
    return;
  }
  const view = camera.viewMatrix;
  let data = material.vertexFrameData;
  if (!data || data.length !== width * 4 * 4) {
    data = material.vertexFrameData = new Float32Array(width * 4 * 4);
  }
  let nearest;
  let nearestDistance = Infinity;
  vertices.forEach((vertex, v) => {
    const eye = Matrix4.multiplyByPoint(view, vertex.position, scratchVertexEye);
    data.set([eye.x, eye.y, eye.z, vertex.interior ? 1 : 0], v * 4);
    const distance = Cartesian3.magnitude(eye); // the camera is the eye-space origin
    if (vertex.interior && distance < nearestDistance) {
      nearestDistance = distance;
      nearest = { vertex, v, eye: Cartesian3.clone(eye) };
    }
    ["incoming", "outgoing", "up"].forEach((key, row) => {
      const direction = Matrix4.multiplyByPointAsVector(view, vertex[key], scratchVertexEye);
      data.set([direction.x, direction.y, direction.z, 0], ((row + 1) * width + v) * 4);
    });
  });
  material.pendingVertexFrames = { width, data };

  if (nearest) {
    const { vertex, v, eye } = nearest;
    const at = (row) => data.subarray(((row + 1) * width + v) * 4, ((row + 1) * width + v) * 4 + 3);
    const [ix, iy, iz] = at(0);
    const [ox, oy, oz] = at(1);
    const [ux, uy, uz] = at(2);
    const lengthBefore = vertex.distance - vertices[v - 1].distance;
    const lengthAfter = vertices[v + 1].distance - vertex.distance;
    // w: 1 + 2 if the segment before starts the line + 4 if the segment after ends it.
    const flags = 1 + (v === 1 ? 2 : 0) + (v === width - 2 ? 4 : 0);
    Cartesian4.fromElements(eye.x, eye.y, eye.z, flags, uniforms.nearVertex);
    Cartesian4.fromElements(ix, iy, iz, lengthBefore, uniforms.nearIncoming);
    Cartesian4.fromElements(ox, oy, oz, lengthAfter, uniforms.nearOutgoing);
    Cartesian4.fromElements(ux, uy, uz, vertex.distance % modulus, uniforms.nearUp);
  }
}

/** Width / height of an image element or canvas; 1 when unknown (null, or a URL not loaded). */
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
