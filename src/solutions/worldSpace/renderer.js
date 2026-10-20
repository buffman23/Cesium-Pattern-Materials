import {
  BoundingSphere,
  Cartesian3,
  Math as CesiumMath,
  Color,
  Ellipsoid,
  GeometryInstance,
  GroundPolylineGeometry,
  GroundPolylinePrimitive,
  GroundPrimitive,
  Material,
  MaterialAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  PolylineMaterialAppearance,
} from "cesium";
import PolylinePatternMaterial from "./PolylinePatternMaterial.js";
import PolygonPatternMaterial from "./PolygonPatternMaterial.js";
import {
  DEFAULT_LINE_IMAGE,
  DEFAULT_STAMP_IMAGE,
  HATCH_COLOR,
  HATCH_TILE_PIXELS,
  HATCH_URL,
  LINE_COLOR,
  LINE_IMAGES,
  LINE_WIDTH,
  STAMP_COLOR,
  STAMP_IMAGES,
  STAMP_SPACING,
} from "../../shared/testPatterns.js";

/**
 * Solution 2: both shapes are clamped to the globe (GroundPolylinePrimitive / GroundPrimitive),
 * so they follow the earth's curvature and are never hidden by it when the camera tilts.
 * Patterns are anchored to the ground but keep a near-constant on-screen size.
 */
export default async function createRenderer(viewer) {
  const scene = viewer.scene;
  const primitives = scene.primitives;

  // Ground primitives must know approximate terrain heights before they can be created
  // synchronously (asynchronous: false), which keeps editing flicker free.
  // Load and decode the pattern images once; every shape's material shares them, so new shapes
  // don't each wait for their own image load.
  const [lineImages, stampImages, hatchImage] = await Promise.all([
    loadImages(LINE_IMAGES),
    loadImages(STAMP_IMAGES),
    loadImage(HATCH_URL),
    GroundPrimitive.initializeTerrainHeights(),
  ]);

  const outlineMaterial = Material.fromType("Color", { color: Color.WHITE.withAlpha(0.8) });

  // shape.id -> render state
  const rendered = new Map();
  let lineWidth = LINE_WIDTH;
  let stampSpacing = STAMP_SPACING;
  let maxHeight = Infinity; // camera height above which patterns keep their ground size
  let heightTransition = 0; // meters below maxHeight over which that eases in
  let lineImageKey = DEFAULT_LINE_IMAGE; // a key of LINE_IMAGES, or null for no line
  let stampImageKey = DEFAULT_STAMP_IMAGE; // a key of STAMP_IMAGES, or null for no stamps
  const lineImageFor = (key) => (key ? lineImages[key] : null);
  const stampImageFor = (key) => (key ? stampImages[key] : null);

  // Geometry detail scales with the shape's size, so rebuilding it (every drag step) costs about
  // the same for a city as for a continent. Cesium otherwise subdivides lines every 10 km and
  // polygons on a 1 degree grid, which made editing continent-sized shapes lag.
  const detail = {
    lineSegments: 256, // target number of pieces per line
    minLineGranularity: 9999, // meters (Cesium's default; finer than this isn't needed)
    maxLineGranularity: 200000, // meters; coarser pieces sag too far below the curved ground
    polygonCells: 32, // target number of grid cells across a polygon
    minPolygonGranularity: CesiumMath.RADIANS_PER_DEGREE, // Cesium's default
    maxPolygonGranularity: 5 * CesiumMath.RADIANS_PER_DEGREE,
  };
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  function lineGranularity(positions, loop) {
    let length = 0;
    for (let i = 1; i < positions.length; i++) {
      length += Cartesian3.distance(positions[i - 1], positions[i]);
    }
    if (loop && positions.length > 2) {
      length += Cartesian3.distance(positions[positions.length - 1], positions[0]);
    }
    return clamp(length / detail.lineSegments, detail.minLineGranularity, detail.maxLineGranularity);
  }

  function polygonGranularity(positions) {
    const radius = BoundingSphere.fromPoints(positions).radius;
    const extent = (2 * radius) / Ellipsoid.WGS84.maximumRadius; // radians across
    return clamp(extent / detail.polygonCells, detail.minPolygonGranularity, detail.maxPolygonGranularity);
  }

  function groundLine(positions, width, material, loop = false) {
    return primitives.add(
      new GroundPolylinePrimitive({
        geometryInstances: new GeometryInstance({
          geometry: new GroundPolylineGeometry({
            positions,
            width,
            loop,
            granularity: lineGranularity(positions, loop),
          }),
        }),
        appearance: new PolylineMaterialAppearance({ material }),
        asynchronous: false,
      }),
    );
  }

  function replace(state, key, primitive) {
    if (state[key]) {
      primitives.remove(state[key]);
    }
    state[key] = primitive;
  }

  function updatePolyline(shape) {
    let state = rendered.get(shape.id);
    if (!state) {
      state = {
        material: PolylinePatternMaterial.create({
          lineImage: lineImageFor(lineImageKey),
          stampImage: stampImageFor(stampImageKey),
          lineColor: LINE_COLOR,
          stampColor: STAMP_COLOR,
          spacing: stampSpacing,
          maxHeight,
          heightTransition,
        }),
      };
      rendered.set(shape.id, state);
    }
    state.positions = shape.positions.slice();
    buildPolyline(state);
  }

  function buildPolyline(state) {
    PolylinePatternMaterial.setPositions(state.material, state.positions, lineWidth);
    PolylinePatternMaterial.updateCamera(state.material, scene);
    replace(state, "primitive", groundLine(state.positions, lineWidth, state.material));
  }

  function updatePolygon(shape) {
    let state = rendered.get(shape.id);
    if (!state) {
      state = {
        polygonMaterial: PolygonPatternMaterial.create({
          image: hatchImage,
          color: HATCH_COLOR,
          tileSize: HATCH_TILE_PIXELS,
          maxHeight,
          heightTransition,
        }),
      };
      rendered.set(shape.id, state);
    }
    state.shape = shape;
    const positions = shape.positions;
    PolygonPatternMaterial.setOrigin(state.polygonMaterial, positions);
    PolygonPatternMaterial.updateCamera(state.polygonMaterial, scene);

    replace(
      state,
      "primitive",
      primitives.add(
        new GroundPrimitive({
          geometryInstances: new GeometryInstance({
            geometry: new PolygonGeometry({
              polygonHierarchy: new PolygonHierarchy(positions),
              vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
              granularity: polygonGranularity(positions),
            }),
          }),
          appearance: new MaterialAppearance({
            material: state.polygonMaterial,
            materialSupport: MaterialAppearance.MaterialSupport.TEXTURED,
            translucent: true,
            flat: true,
          }),
          asynchronous: false,
        }),
      ),
    );
    replace(state, "outline", groundLine(positions, 2, outlineMaterial, true));
  }

  // The scene renders on demand (requestRenderMode). While any pattern image is still being
  // turned into a texture, keep requesting frames so it appears without moving the camera.
  // (The materials request frames themselves while their zoom fades settle.)
  const removePostRender = scene.postRender.addEventListener(() => {
    for (const state of rendered.values()) {
      for (const material of [state.material, state.polygonMaterial]) {
        if (material?.loadingImages?.size > 0) {
          scene.requestRender();
          return;
        }
      }
    }
  });

  // Both patterns need the current camera every frame (precision at close zoom, zoom fades).
  const removePreRender = scene.preRender.addEventListener(() => {
    for (const state of rendered.values()) {
      if (state.polygonMaterial) {
        PolygonPatternMaterial.updateCamera(state.polygonMaterial, scene);
      }
      if (state.material) {
        PolylinePatternMaterial.updateCamera(state.material, scene);
      }
    }
  });

  function remove(shape) {
    const state = rendered.get(shape.id);
    if (!state) {
      return;
    }
    for (const key of ["primitive", "outline"]) {
      if (state[key]) {
        primitives.remove(state[key]);
      }
    }
    for (const material of [state.material, state.polygonMaterial]) {
      if (material && !material.isDestroyed()) {
        material.destroy();
      }
    }
    rendered.delete(shape.id);
  }

  return {
    update: (shape) => (shape.type === "polyline" ? updatePolyline(shape) : updatePolygon(shape)),
    remove,
    /** Sets the polyline width in pixels and rebuilds existing polylines with it. */
    setLineWidth(width) {
      lineWidth = width;
      for (const state of rendered.values()) {
        if (state.material) {
          buildPolyline(state);
        }
      }
    },
    /** Overrides geometry detail settings (see `detail`) and rebuilds every shape. */
    setDetail(settings) {
      Object.assign(detail, settings);
      for (const state of rendered.values()) {
        if (state.material) {
          buildPolyline(state);
        } else if (state.shape) {
          updatePolygon(state.shape);
        }
      }
    },
    /**
     * Sets the camera height (meters, Infinity = off) above which both patterns keep their
     * ground size, and the meters below it over which that eases in. Read by the materials'
     * updateCamera, so no rebuild needed.
     */
    setMaxHeight({ maxHeight: height = maxHeight, heightTransition: transition = heightTransition } = {}) {
      maxHeight = height;
      heightTransition = transition;
      for (const state of rendered.values()) {
        for (const material of [state.material, state.polygonMaterial]) {
          if (material) {
            material.maxHeight = maxHeight;
            material.heightTransition = heightTransition;
          }
        }
      }
    },
    /** Sets the stamp spacing multiplier (1 = touching); a uniform, so no rebuild needed. */
    setStampSpacing(spacing) {
      stampSpacing = spacing;
      for (const state of rendered.values()) {
        if (state.material) {
          state.material.uniforms.spacing = spacing;
        }
      }
    },
    /**
     * Sets the line and/or stamp image by key (see LINE_IMAGES / STAMP_IMAGES); null removes
     * that layer, undefined leaves it unchanged.
     */
    setImages({ line, stamp } = {}) {
      if (line !== undefined) {
        lineImageKey = line;
      }
      if (stamp !== undefined) {
        stampImageKey = stamp;
      }
      for (const state of rendered.values()) {
        if (state.material) {
          PolylinePatternMaterial.setImages(state.material, {
            lineImage: lineImageFor(lineImageKey),
            stampImage: stampImageFor(stampImageKey),
          });
        }
      }
    },
    destroy() {
      for (const id of [...rendered.keys()]) {
        remove({ id });
      }
      removePreRender();
      removePostRender();
      outlineMaterial.destroy();
    },
  };
}

/** Loads and decodes every image of a { key: url } map into { key: HTMLImageElement }. */
async function loadImages(urls) {
  const entries = await Promise.all(
    Object.entries(urls).map(async ([key, url]) => [key, await loadImage(url)]),
  );
  return Object.fromEntries(entries);
}

async function loadImage(url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}
