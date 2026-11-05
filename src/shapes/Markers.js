import {
  Cartesian2,
  Color,
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
 *  - color / activeColor / hoverColor: tints (default white / yellow / light blue).
 *  - scale:          multiplies every marker's size (default 1).
 *  - deletable:      vertex markers get a red X (shown on hover / after a click) that deletes
 *                    the vertex. deleteImage / deleteOffset (pixels) change it.
 *  - numbered:       vertex markers are numbered pins (PinBuilder). pinColor / pinSize.
 *  - translatable:   shows a translate marker that moves the whole shape. translateImage.
 *  - groundLine:     at altitude, draws a line from each marker straight down to the ground.
 */
export const DEFAULT_MARKER_OPTIONS = Object.freeze({
  image: undefined,
  width: 12,
  height: 12,
  color: Color.WHITE,
  activeColor: Color.YELLOW,
  hoverColor: Color.fromCssColorString("#a8d8ff"),
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

function canvas(size, draw) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  draw(c.getContext("2d"), size);
  return c;
}

let squareImage;
/** White square with a thin black outline (tint it with the billboard color). */
export function defaultMarkerImage() {
  squareImage ??= canvas(24, (ctx, s) => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = "#fff";
    ctx.fillRect(2, 2, s - 4, s - 4);
  });
  return squareImage;
}

let deleteImage;
/** Red X on a white disc. */
export function defaultDeleteImage() {
  deleteImage ??= canvas(32, (ctx, s) => {
    const r = s / 2;
    ctx.beginPath();
    ctx.arc(r, r, r - 1.5, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#222";
    ctx.stroke();
    ctx.beginPath();
    const d = s * 0.27;
    ctx.moveTo(r - d, r - d);
    ctx.lineTo(r + d, r + d);
    ctx.moveTo(r + d, r - d);
    ctx.lineTo(r - d, r + d);
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#e01b24";
    ctx.stroke();
  });
  return deleteImage;
}

let translateImage;
/** Four-way move arrows, white with a black outline. */
export function defaultTranslateImage() {
  translateImage ??= canvas(40, (ctx, s) => {
    const c = s / 2;
    const arm = s * 0.42;
    const head = s * 0.16;
    ctx.beginPath();
    ctx.moveTo(c - arm, c);
    ctx.lineTo(c + arm, c);
    ctx.moveTo(c, c - arm);
    ctx.lineTo(c, c + arm);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const tipX = c + dx * arm;
      const tipY = c + dy * arm;
      ctx.moveTo(tipX - dx * head - dy * head, tipY - dy * head - dx * head);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(tipX - dx * head + dy * head, tipY - dy * head + dx * head);
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3;
    ctx.stroke();
  });
  return translateImage;
}

const pinBuilder = new PinBuilder();
const pins = new Map();
/** Numbered pin, cached per text, color and size. */
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

  setHover(key) {
    if (key === this.hoverKey) {
      return;
    }
    const previous = this.hoverKey;
    this.hoverKey = key;
    this.#restyle(previous);
    this.#restyle(key);
    this.#syncDelete();
  }

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
    if (spec.role === "translate") {
      image = o.translateImage ?? defaultTranslateImage();
      width = 22;
      height = 22;
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
    billboard.width = width * o.scale;
    billboard.height = height * o.scale;
    billboard.verticalOrigin = verticalOrigin;
    // Pins keep their own colors; only tint them when active.
    const base = this.#isPin(spec) ? Color.WHITE : o.color;
    billboard.color =
      spec.key === this.activeKey ? o.activeColor : spec.key === this.hoverKey ? o.hoverColor : base;
  }

  #syncDelete() {
    const key = this.hoverKey ?? this.selectedKey;
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
