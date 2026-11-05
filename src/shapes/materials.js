import { Color, Material } from "cesium";
import PolylinePatternMaterial from "../solutions/worldSpace/PolylinePatternMaterial.js";
import PolygonPatternMaterial from "../solutions/worldSpace/PolygonPatternMaterial.js";
import { boundingBoxDiagonal, fitMaxHeight } from "../shared/maxHeight.js";

/**
 * Shape materials.
 *
 * A shape doesn't take Cesium Materials directly but *material specs*: descriptions a shape
 * turns into material instances itself, so one spec can be shared by many shapes (and by
 * many lines of one shape) while each gets the state it needs. A spec is:
 *
 *   {
 *     isShapeMaterial: true,
 *     stateful,                  // instances hold per-line state: one instance per line
 *     supportsAltitude,          // false = only works on ground-clamped primitives
 *     requiresGeodesicSegments,  // instances assume geodesic segments (densify rhumb lines)
 *     tint,                      // Color, used for the solid fallback at altitude
 *     json,                      // optional serializable description (see materialFromJSON)
 *     create() -> instance,
 *   }
 *
 * and an instance:
 *
 *   {
 *     material,                       // the Cesium Material
 *     setLine?(positions, widthPx),   // outline instances; returns extra lines
 *                                     //   [{ positions, width }] drawn with the same material
 *     setFill?(positions),            // fill instances: the boundary
 *     update?(scene),                 // every frame while visible
 *     loading?,                       // true while images are still turning into textures
 *     destroy(),
 *   }
 *
 * {@link toShapeMaterial} also accepts a Color or a Cesium Material.
 */

export const DEFAULT_OUTLINE_COLOR = Color.WHITE.withAlpha(0.8);
export const DEFAULT_FILL_COLOR = Color.WHITE.withAlpha(0.25);

/** A solid color. */
export function colorMaterial(color) {
  return {
    isShapeMaterial: true,
    stateful: false,
    supportsAltitude: true,
    requiresGeodesicSegments: false,
    tint: color,
    json: { type: "color", color: color.toCssColorString() },
    create() {
      const material = Material.fromType("Color", { color });
      return { material, destroy: () => material.destroy() };
    },
  };
}

/**
 * An existing Cesium Material (e.g. `Material.fromType("Stripe", …)`), shared by every shape
 * that uses this spec and never destroyed by them.
 */
export function cesiumMaterial(material, { tint = Color.WHITE, json } = {}) {
  return {
    isShapeMaterial: true,
    stateful: false,
    supportsAltitude: true,
    requiresGeodesicSegments: false,
    tint,
    json,
    create() {
      return { material, destroy() {} };
    },
  };
}

/**
 * Patterned ground line (PolylinePatternMaterial). Options are those of
 * PolylinePatternMaterial.create, plus `maxHeightFactor` / `easeFrom` (max camera height in
 * fit heights of each line, see maxHeight.js; default off). Ground-clamped shapes only.
 */
export function patternLineMaterial(options = {}, { json } = {}) {
  const { maxHeightFactor = Infinity, easeFrom = 0, ...materialOptions } = options;
  return {
    isShapeMaterial: true,
    stateful: true,
    supportsAltitude: false,
    requiresGeodesicSegments: true,
    tint: materialOptions.lineColor ?? materialOptions.stampColor ?? Color.WHITE,
    json,
    create() {
      const material = PolylinePatternMaterial.create(materialOptions);
      let diagonal = 0;
      return {
        material,
        setLine(positions, width) {
          PolylinePatternMaterial.setPositions(material, positions, width);
          diagonal = boundingBoxDiagonal(positions);
          return PolylinePatternMaterial.cornerCaps(material);
        },
        update(scene) {
          const fitted = fitMaxHeight(diagonal, scene.camera, maxHeightFactor, easeFrom);
          material.maxHeight = fitted.maxHeight;
          material.heightTransition = fitted.heightTransition;
          PolylinePatternMaterial.updateCamera(material, scene);
        },
        get loading() {
          return material.loadingImages?.size > 0;
        },
        destroy: () => material.destroy(),
      };
    },
  };
}

/**
 * Ground-anchored tiled fill (PolygonPatternMaterial). Options are those of
 * PolygonPatternMaterial.create, plus `maxHeightFactor` / `easeFrom`. Ground-clamped shapes
 * only.
 */
export function patternFillMaterial(options, { json } = {}) {
  const { maxHeightFactor = Infinity, easeFrom = 0, ...materialOptions } = options;
  return {
    isShapeMaterial: true,
    stateful: true,
    supportsAltitude: false,
    requiresGeodesicSegments: false,
    tint: materialOptions.color ?? Color.WHITE,
    json,
    create() {
      const material = PolygonPatternMaterial.create(materialOptions);
      let diagonal = 0;
      return {
        material,
        setFill(positions) {
          PolygonPatternMaterial.setOrigin(material, positions);
          diagonal = boundingBoxDiagonal(positions);
        },
        update(scene) {
          const fitted = fitMaxHeight(diagonal, scene.camera, maxHeightFactor, easeFrom);
          material.maxHeight = fitted.maxHeight;
          material.heightTransition = fitted.heightTransition;
          PolygonPatternMaterial.updateCamera(material, scene);
        },
        get loading() {
          return material.loadingImages?.size > 0;
        },
        destroy: () => material.destroy(),
      };
    },
  };
}

/** Turns a Color, a Cesium Material or a spec into a spec (undefined stays undefined). */
export function toShapeMaterial(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value.isShapeMaterial) {
    return value;
  }
  if (value instanceof Color) {
    return colorMaterial(value);
  }
  if (value instanceof Material) {
    return cesiumMaterial(value);
  }
  throw new Error("Expected a Color, a Cesium Material or a shape material spec.");
}

const warned = new WeakSet();

/**
 * The spec to use at altitude: the spec itself if it supports altitude, otherwise a solid
 * color of its tint (warning once per spec).
 */
export function altitudeFallback(spec) {
  if (spec.supportsAltitude !== false) {
    return spec;
  }
  if (!warned.has(spec)) {
    warned.add(spec);
    console.warn(
      "Shape material only works on ground-clamped shapes; using a solid color at altitude.",
    );
  }
  spec.altitudeFallback ??= colorMaterial(spec.tint ?? Color.WHITE);
  return spec.altitudeFallback;
}

/**
 * Recreates a spec from its `json`. Colors are built in; anything else is passed to
 * `resolve(json)` (e.g. the demo maps pattern keys back to pattern specs).
 */
export function materialFromJSON(json, resolve) {
  if (!json) {
    return undefined;
  }
  if (json.type === "color") {
    return colorMaterial(Color.fromCssColorString(json.color));
  }
  return resolve?.(json);
}
