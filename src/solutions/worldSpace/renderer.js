import {
  Color,
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
  let vertexMode = PolylinePatternMaterial.VertexMode.CLIP;
  let lineImageKey = DEFAULT_LINE_IMAGE; // a key of LINE_IMAGES, or null for no line
  let stampImageKey = DEFAULT_STAMP_IMAGE; // a key of STAMP_IMAGES, or null for no stamps
  const lineImageFor = (key) => (key ? lineImages[key] : null);
  const stampImageFor = (key) => (key ? stampImages[key] : null);

  function groundLine(positions, width, material, loop = false) {
    return primitives.add(
      new GroundPolylinePrimitive({
        geometryInstances: new GeometryInstance({
          geometry: new GroundPolylineGeometry({ positions, width, loop }),
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
          vertexMode,
        }),
      };
      rendered.set(shape.id, state);
    }
    state.positions = shape.positions.slice();
    buildPolyline(state);
  }

  function buildPolyline(state) {
    PolylinePatternMaterial.setPositions(state.material, state.positions, lineWidth);
    PolylinePatternMaterial.updateCamera(state.material, scene.camera);
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
        }),
      };
      rendered.set(shape.id, state);
    }
    const positions = shape.positions;
    PolygonPatternMaterial.setOrigin(state.polygonMaterial, positions);
    PolygonPatternMaterial.updateCamera(state.polygonMaterial, scene.camera);

    replace(
      state,
      "primitive",
      primitives.add(
        new GroundPrimitive({
          geometryInstances: new GeometryInstance({
            geometry: new PolygonGeometry({
              polygonHierarchy: new PolygonHierarchy(positions),
              vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
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

  // Both patterns need the current camera every frame (precision at close zoom).
  const removePreRender = scene.preRender.addEventListener(() => {
    for (const state of rendered.values()) {
      if (state.polygonMaterial) {
        PolygonPatternMaterial.updateCamera(state.polygonMaterial, scene.camera);
      }
      if (state.material) {
        PolylinePatternMaterial.updateCamera(state.material, scene.camera);
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
    /** Sets how stamps behave at vertices (a PolylinePatternMaterial.VertexMode value). */
    setVertexMode(mode) {
      vertexMode = mode;
      for (const state of rendered.values()) {
        if (state.material) {
          state.material.uniforms.vertexMode = mode;
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
