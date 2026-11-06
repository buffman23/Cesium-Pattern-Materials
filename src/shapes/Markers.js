import {
  Cartesian2,
  Cartesian3,
  Color,
  Ellipsoid,
  HorizontalOrigin,
  Material,
  PinBuilder,
  VerticalOrigin,
  createGuid,
} from "cesium";
import { withHeight } from "./geodesy.js";

/**
 * Marker (edit handle) images and the billboards of the shape being edited.
 *
 * Marker options (shape.markerOptions):
 *  - image:          URL, image or canvas for regular markers (default: white square, thin
 *                    black outline). width / height: its size in pixels (default 12 x 12).
 *  - color:          tint of plain markers (default white).
 *  - hoverColor / activeColor: tint while hovered / dragged, for every kind of marker alike.
 *                    Off by default (undefined): markers keep their color when hovered or
 *                    dragged.
 *  - scale:          multiplies every marker's size (default 1).
 *  - deletable:      vertex markers get a red X that deletes the vertex. It appears when the
 *                    marker is hovered or clicked and stays until another marker is hovered.
 *                    deleteImage / deleteOffset (pixels) change it.
 *  - numbered:       vertex markers are numbered pins (PinBuilder). pinColor / pinSize.
 *  - translatable:   shows a translate marker that moves the whole shape. translateImage.
 *  - groundLine:     at altitude, draws a line from each marker straight down to the ground.
 *  - roleStyles:     looks per marker role, merged per role over DEFAULT_ROLE_STYLES: resize
 *                    handles (width, radius) are cyan double arrows that point along the
 *                    resize direction, rotate handles (end, start) orange circular arrows;
 *                    other roles use `image`. E.g. { width: { image: url } }; null removes
 *                    one.
 */
export const DEFAULT_MARKER_OPTIONS = Object.freeze({
  image: undefined,
  width: 12,
  height: 12,
  color: Color.WHITE,
  activeColor: undefined, // no drag tint
  hoverColor: undefined, // no hover tint
  scale: 1,
  deletable: false,
  deleteImage: undefined,
  deleteOffset: new Cartesian2(14, -14),
  numbered: false,
  pinColor: Color.fromCssColorString("#2d6cdf"),
  pinSize: 36,
  translatable: true,
  translateImage: undefined,
  groundLine: false,
});

// --- Images ----------------------------------------------------------------------------------

const imageIds = new WeakMap();

/** A stable atlas id for an image, so billboards reuse one texture atlas entry per image. */
function imageId(image) {
  if (typeof image === "string") {
    return image;
  }
  let id = imageIds.get(image);
  if (!id) {
    id = createGuid();
    imageIds.set(image, id);
  }
  return id;
}

// The default images are inline SVGs (data URIs), so the library needs no asset files. Their
// intrinsic size, which is what Cesium rasterizes into the billboard atlas, is twice the
// drawn size, so they stay sharp on high-DPI screens; billboards set the drawn size.
const svgImage = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

const SQUARE_SVG = svgImage(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
    '<rect width="24" height="24" fill="#000"/>' +
    '<rect x="2" y="2" width="20" height="20" fill="#fff"/>' +
    "</svg>",
);

const DELETE_SVG = svgImage(
  '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">' +
    '<path d="M8 8L28 28M28 8L8 28" stroke="#e01b24" stroke-width="6" stroke-linecap="round"/>' +
    "</svg>",
);

// Four-way arrows: a black outline stroke under a white one.
const ARROWS_PATH =
  "M4 20H36M20 4V36" +
  "M31 15L36 20L31 25M9 15L4 20L9 25" +
  "M15 31L20 36L25 31M15 9L20 4L25 9";
const TRANSLATE_SVG = svgImage(
  '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 40 40">' +
    `<path d="${ARROWS_PATH}" fill="none" stroke="#000" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${ARROWS_PATH}" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    "</svg>",
);

/** White square with a thin black outline (tint it with the billboard color); an SVG data URI. */
export function defaultMarkerImage() {
  return SQUARE_SVG;
}

const coloredSquares = new Map();
/**
 * The marker square in a fixed color (e.g. "#29b6f6"), with the same thin black outline; an
 * SVG data URI. For role styles (hover / drag tint it like the white square).
 */
export function coloredMarkerImage(color) {
  let image = coloredSquares.get(color);
  if (!image) {
    image = svgImage(
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
        '<rect width="24" height="24" fill="#000"/>' +
        `<rect x="2" y="2" width="20" height="20" fill="${color}"/>` +
        "</svg>",
    );
    coloredSquares.set(color, image);
  }
  return image;
}

/** Colors of the resize and rotate icons, for shapes that use colored squares instead. */
export const RESIZE_COLOR = "#29b6f6";
export const ROTATE_COLOR = "#ffa726";
/** Yellow of size handles drawn as squares (Box width, Corridor radius). */
export const WIDTH_COLOR = "#ffeb3b";

/** Red X; an SVG data URI. */
export function defaultDeleteImage() {
  return DELETE_SVG;
}

/** Four-way move arrows, white with a black outline; an SVG data URI. */
export function defaultTranslateImage() {
  return TRANSLATE_SVG;
}

// Resize handles: a cyan double-headed arrow, drawn vertical (billboards turn it to point
// along the resize direction, see spec.axis).
const RESIZE_SVG = svgImage(
  '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 22 22">' +
    '<path d="M11 1L17 7.5H13.5V14.5H17L11 21L5 14.5H8.5V7.5H5Z" fill="#29b6f6" ' +
    'stroke="#08202c" stroke-width="1.4" stroke-linejoin="round"/>' +
    "</svg>",
);

// Rotate handles: an orange circular arrow around a center dot.
const ROTATE_ARC = "M11 4A7 7 0 1 1 4 11";
const ROTATE_SVG = svgImage(
  '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 22 22">' +
    `<path d="${ROTATE_ARC}" fill="none" stroke="#2b1700" stroke-width="5" stroke-linecap="round"/>` +
    `<path d="${ROTATE_ARC}" fill="none" stroke="#ffa726" stroke-width="2.6" stroke-linecap="round"/>` +
    '<path d="M0.8 11.5L7.2 11.5L4 6.3Z" fill="#ffa726" stroke="#2b1700" stroke-width="1.2" stroke-linejoin="round"/>' +
    '<circle cx="11" cy="11" r="2.2" fill="#ffa726" stroke="#2b1700" stroke-width="1.2"/>' +
    "</svg>",
);

/** Cyan double-headed arrow for resize handles (width, radius); an SVG data URI. */
export function defaultResizeImage() {
  return RESIZE_SVG;
}

/** Orange circular arrow for rotate handles (Box ends, Sector arc ends); an SVG data URI. */
export function defaultRotateImage() {
  return ROTATE_SVG;
}

/**
 * Marker looks per role (see markerOptions.roleStyles): { image, width, height, align }.
 * `align`: turn the image so its up points along the marker spec's `axis` (a bearing).
 * Roles without an entry use the `image` option (default: the white square).
 */
export const DEFAULT_ROLE_STYLES = Object.freeze({
  width: Object.freeze({ image: RESIZE_SVG, width: 22, height: 22, align: true }),
  radius: Object.freeze({ image: RESIZE_SVG, width: 22, height: 22, align: true }),
  end: Object.freeze({ image: ROTATE_SVG, width: 22, height: 22 }),
  start: Object.freeze({ image: ROTATE_SVG, width: 22, height: 22 }),
  // Vertical handles (e.g. a corridor cylinder's min / max altitude): the resize arrow, upright.
  altitude: Object.freeze({ image: RESIZE_SVG, width: 22, height: 22, align: true }),
});

/** Role styles merged per role: each override's properties replace the defaults' ones. */
export function mergeRoleStyles(...tables) {
  const merged = {};
  for (const table of tables) {
    for (const [role, style] of Object.entries(table ?? {})) {
      merged[role] = style ? { ...merged[role], ...style } : undefined; // null removes a role style
    }
  }
  return merged;
}

const scratchUp = new Cartesian3();
const scratchEast = new Cartesian3();
const scratchNorth = new Cartesian3();

// Unit vector in world space pointing along `bearing` at `position`, for alignedAxis.
function bearingAxis(position, bearing) {
  const up = Ellipsoid.WGS84.geodeticSurfaceNormal(position, scratchUp);
  let east = Cartesian3.cross(Cartesian3.UNIT_Z, up, scratchEast);
  if (Cartesian3.magnitudeSquared(east) < 1e-12) {
    east = Cartesian3.clone(Cartesian3.UNIT_Y, scratchEast); // at a pole: any east will do
  }
  Cartesian3.normalize(east, east);
  const north = Cartesian3.cross(up, east, scratchNorth);
  const axis = Cartesian3.add(
    Cartesian3.multiplyByScalar(east, Math.sin(bearing), new Cartesian3()),
    Cartesian3.multiplyByScalar(north, Math.cos(bearing), scratchNorth),
    new Cartesian3(),
  );
  return Cartesian3.normalize(axis, axis);
}

const pinBuilder = new PinBuilder();
const pins = new Map();
/** Numbered pin (a canvas: PinBuilder draws pins on canvases), cached per text, color, size. */
export function numberedPinImage(text, color, size) {
  const key = `${text}|${color.toCssColorString()}|${size}`;
  let pin = pins.get(key);
  if (!pin) {
    pin = pinBuilder.fromText(String(text), color, size);
    pins.set(key, pin);
  }
  return pin;
}

// --- MarkerSet -------------------------------------------------------------------------------

/**
 * A marker spec, from Shape.markerSpecs():
 *   { key, position, role, deletable?, label?, index?, ...subclass data }
 * role: "vertex" | "translate" | anything a subclass handles in onMarkerDrag.
 * Optional: axis (bearing a resize icon points along), axisUp (point it vertically instead),
 * pixelOffset (Cartesian2), vertical (drags change height, see ShapeEditor).
 *
 * Billboard ids are { shape, key, kind: "marker" | "delete" } so the editor can route picks.
 */
export class MarkerSet {
  constructor(editor, shape) {
    this.editor = editor;
    this.shape = shape;
    this.billboards = editor.billboards;
    this.markers = new Map(); // key -> billboard
    this.lines = new Map(); // key -> ground line (only with groundLine at altitude)
    this.specs = new Map(); // key -> spec
    this.hoverKey = undefined;
    this.selectedKey = undefined;
    this.activeKey = undefined; // being dragged
    this.deleteBillboard = undefined;
  }

  spec(key) {
    return this.specs.get(key);
  }

  /**
   * True while a shown billboard's image is still loading (SVGs and URLs load
   * asynchronously); the editor keeps requesting frames until then, for requestRenderMode.
   */
  get loading() {
    for (const billboard of this.markers.values()) {
      if (!billboard.ready) {
        return true;
      }
    }
    return Boolean(this.deleteBillboard?.show && !this.deleteBillboard.ready);
  }

  /** Creates, moves or removes billboards to match the specs. */
  sync(specs) {
    const seen = new Set();
    this.specs.clear();
    for (const spec of specs) {
      seen.add(spec.key);
      this.specs.set(spec.key, spec);
      let billboard = this.markers.get(spec.key);
      if (!billboard) {
        billboard = this.billboards.add({
          position: spec.position,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          horizontalOrigin: HorizontalOrigin.CENTER,
          id: { shape: this.shape, key: spec.key, kind: "marker" },
        });
        this.markers.set(spec.key, billboard);
      } else {
        billboard.position = spec.position;
      }
      this.#style(billboard, spec);
      this.#syncGroundLine(spec);
    }
    for (const [key, billboard] of this.markers) {
      if (!seen.has(key)) {
        this.billboards.remove(billboard);
        this.markers.delete(key);
        this.#removeGroundLine(key);
      }
    }
    if (this.selectedKey && !seen.has(this.selectedKey)) {
      this.selectedKey = undefined;
    }
    if (this.hoverKey && !seen.has(this.hoverKey)) {
      this.hoverKey = undefined;
    }
    this.#syncDelete();
    this.editor.scene.requestRender();
  }

  /**
   * The marker under the pointer (or undefined). Hovering a marker also makes it the one whose
   * X shows; moving off it keeps the X, so the pointer can travel to the X without it
   * vanishing, until another marker is hovered.
   */
  setHover(key) {
    if (key === this.hoverKey) {
      return;
    }
    const previous = this.hoverKey;
    this.hoverKey = key;
    if (key !== undefined) {
      this.selectedKey = key;
    }
    this.#restyle(previous);
    this.#restyle(key);
    this.#syncDelete();
  }

  /** Makes `key` the marker whose X shows (undefined hides the X). */
  setSelected(key) {
    if (key === this.selectedKey) {
      return;
    }
    this.selectedKey = key;
    this.#syncDelete();
  }

  setActive(key) {
    const previous = this.activeKey;
    this.activeKey = key;
    this.#restyle(previous);
    this.#restyle(key);
    this.#syncDelete();
  }

  /** Re-applies marker styles (after the shape's marker options changed). */
  restyleAll() {
    for (const key of this.markers.keys()) {
      this.#restyle(key);
    }
    this.#syncDelete();
  }

  destroy() {
    for (const billboard of this.markers.values()) {
      this.billboards.remove(billboard);
    }
    for (const key of [...this.lines.keys()]) {
      this.#removeGroundLine(key);
    }
    if (this.deleteBillboard) {
      this.billboards.remove(this.deleteBillboard);
    }
    this.markers.clear();
    this.specs.clear();
    this.deleteBillboard = undefined;
    this.editor.scene.requestRender();
  }

  #restyle(key) {
    const billboard = key && this.markers.get(key);
    const spec = key && this.specs.get(key);
    if (billboard && spec) {
      this.#style(billboard, spec);
      this.editor.scene.requestRender();
    }
  }

  #isPin(spec) {
    return this.shape.markerOptions.numbered && spec.label !== undefined;
  }

  #style(billboard, spec) {
    const o = this.shape.markerOptions;
    let image;
    let width;
    let height;
    let verticalOrigin = VerticalOrigin.CENTER;
    const roleStyle = spec.role === "translate" ? undefined : o.roleStyles?.[spec.role];
    if (spec.role === "translate") {
      image = o.translateImage ?? defaultTranslateImage();
      width = 22;
      height = 22;
    } else if (roleStyle) {
      image = roleStyle.image;
      width = roleStyle.width ?? 22;
      height = roleStyle.height ?? 22;
    } else if (this.#isPin(spec)) {
      image = numberedPinImage(spec.label, o.pinColor, o.pinSize);
      width = o.pinSize;
      height = o.pinSize;
      verticalOrigin = VerticalOrigin.BOTTOM;
    } else {
      image = o.image ?? defaultMarkerImage();
      width = o.width;
      height = o.height;
    }
    const id = imageId(image);
    if (billboard.image !== id) {
      billboard.setImage(id, image);
    }
    billboard.verticalOrigin = verticalOrigin;
    // Resize icons point along their resize direction whatever the camera heading.
    // spec.axisUp: along the local vertical instead (for up / down handles).
    billboard.alignedAxis = !roleStyle?.align
      ? Cartesian3.ZERO
      : spec.axisUp
        ? Ellipsoid.WGS84.geodeticSurfaceNormal(spec.position, new Cartesian3())
        : spec.axis !== undefined
          ? bearingAxis(spec.position, spec.axis)
          : Cartesian3.ZERO;
    billboard.pixelOffset = spec.pixelOffset ?? Cartesian2.ZERO;
    const active = spec.key === this.activeKey;
    const hover = spec.key === this.hoverKey;
    billboard.width = width * o.scale;
    billboard.height = height * o.scale;
    // Colored role icons and pins keep their own colors (untinted). No hover or drag tint
    // unless hoverColor / activeColor are set, and then the same for every marker.
    const base = roleStyle || this.#isPin(spec) ? Color.WHITE : o.color;
    billboard.color = (active && o.activeColor) || (hover && o.hoverColor) || base;
  }

  #syncDelete() {
    // The last hovered or clicked marker (see setHover), not only the one under the pointer.
    const key = this.selectedKey;
    const spec = key && this.specs.get(key);
    const show = Boolean(spec?.deletable) && this.activeKey === undefined;
    if (!show) {
      if (this.deleteBillboard) {
        this.deleteBillboard.show = false;
      }
      return;
    }
    const o = this.shape.markerOptions;
    if (!this.deleteBillboard) {
      this.deleteBillboard = this.billboards.add({
        position: spec.position,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    const billboard = this.deleteBillboard;
    const image = o.deleteImage ?? defaultDeleteImage();
    const id = imageId(image);
    if (billboard.image !== id) {
      billboard.setImage(id, image);
    }
    billboard.width = 18 * o.scale;
    billboard.height = 18 * o.scale;
    billboard.position = spec.position;
    billboard.pixelOffset = this.#isPin(spec)
      ? new Cartesian2(o.pinSize * 0.5 * o.scale, -o.pinSize * 0.85 * o.scale)
      : Cartesian2.multiplyByScalar(o.deleteOffset, o.scale, new Cartesian2());
    billboard.id = { shape: this.shape, key, kind: "delete" };
    billboard.show = true;
    this.editor.scene.requestRender();
  }

  #syncGroundLine(spec) {
    const wanted = this.shape.markerOptions.groundLine && !this.shape.clampToGround;
    if (!wanted) {
      this.#removeGroundLine(spec.key);
      return;
    }
    const positions = [spec.position, withHeight(spec.position, 0)];
    let line = this.lines.get(spec.key);
    if (!line) {
      line = this.editor.groundLines.add({
        positions,
        width: 1,
        material: Material.fromType("Color", { color: Color.WHITE.withAlpha(0.6) }),
      });
      this.lines.set(spec.key, line);
    } else {
      line.positions = positions;
    }
  }

  #removeGroundLine(key) {
    const line = this.lines.get(key);
    if (line) {
      this.editor.groundLines.remove(line);
      this.lines.delete(key);
    }
  }
}
