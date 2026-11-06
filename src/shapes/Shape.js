import {
  ArcType,
  BoundingSphere,
  Cartesian3,
  Math as CesiumMath,
  Color,
  Event,
  GeometryInstance,
  GroundPolylineGeometry,
  GroundPolylinePrimitive,
  GroundPrimitive,
  Intersect,
  MaterialAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  PolylineGeometry,
  PolylineMaterialAppearance,
  Primitive,
} from "cesium";
import ShapeMode from "./ShapeMode.js";
import { createPolygonGeometry, isWidePolygon } from "./liftedPolygon.js";
import { DEFAULT_MARKER_OPTIONS, MarkerSet } from "./Markers.js";
import {
  DEFAULT_DETAIL,
  centroid,
  densify,
  ellipsoid,
  heightOf,
  lineGranularity,
  lineLength,
  polygonGranularity,
  rotatePositions,
  toCartographic,
  withHeight,
} from "./geodesy.js";
import {
  DEFAULT_FILL_COLOR,
  DEFAULT_OUTLINE_COLOR,
  altitudeFallback,
  colorMaterial,
  materialFromJSON,
  toShapeMaterial,
} from "./materials.js";

/** What needs rebuilding on the next frame (see {@link Shape#invalidate}). */
export const Dirty = Object.freeze({
  FILL: 1,
  OUTLINE: 2,
  MARKERS: 4,
  GEOMETRY: 7, // all of the above: the shape's defining points changed
});

const TEXTURED = MaterialAppearance.MaterialSupport.TEXTURED;
const registry = new Map();
let nextId = 1;

/**
 * Base class of every drawable / editable shape. A shape lives in a {@link ShapeEditor},
 * which routes mouse input to it and rebuilds it at most once per frame.
 *
 * Rendering is done here, once for all subclasses: one fill primitive (GroundPrimitive, or
 * Primitive at altitude) from {@link Shape#createFillGeometry}, and the outline lines from
 * {@link Shape#outlineLines} (GroundPolylinePrimitive, or Primitive + PolylineGeometry at
 * altitude). Lines with the same key and a stateless material share one primitive; stateful
 * materials (patterns) get one material instance and primitive per line.
 *
 * Subclasses define their state and these hooks:
 *  - static type (registered with Shape.register), static hasFill, static defaultMarkerOptions
 *  - getControlPoints() / setControlPoints(points): the points `translate` moves
 *  - onDrawClick(position) -> "continue" | "done", onDrawMove(position),
 *    onDrawFinishRequest("double" | "right"), drawHint(), cursorMessage()
 *  - isValid()
 *  - markerSpecs() -> [{ key, position, role, deletable?, label?, ... }]
 *  - onMarkerDrag(spec, position), onMarkerHeight(spec, height), deleteMarker(spec)
 *  - createFillGeometry() -> geometry description | undefined
 *  - outlineLines() -> [{ positions, loop?, key?, width? }]
 *  - stateToJSON() and static stateFromJSON(json) -> constructor options
 *  - static fields: the fields a form can show and edit (see below)
 *
 * Forms and binding: `static fields` describes each editable field as
 *   { name, label, type, min?, max?, options?, get(shape), set(shape, value) }
 * with types "position" ([lon°, lat°, height m]), "positions" (an array of those), "distance"
 * (meters), "angle" (degrees), "number", "boolean" and "enum" (one of `options`). Read and
 * write them with getField / setField / getFields, which convert units, validate and
 * rebuild. `changed` (and the editor's `shapeChanged`) is raised with
 * (shape, { fields, source, interactive }): the names of the fields that changed this frame,
 * and whether the change came from drawing ("draw"), a marker drag ("drag") or code ("api").
 */
export default class Shape {
  static type = "Shape";
  static hasFill = true;
  static defaultMarkerOptions = {};

  /** Fields every shape has; subclasses add theirs with [...super.fields, ...]. */
  static fields = [
    {
      name: "arcType",
      label: "Arc type",
      type: "enum",
      options: ["GEODESIC", "RHUMB"],
      get: (s) => (s.arcType === ArcType.RHUMB ? "RHUMB" : "GEODESIC"),
      set: (s, v) => s.setArcType(v === "RHUMB" ? ArcType.RHUMB : ArcType.GEODESIC),
    },
    {
      name: "clampToGround",
      label: "Clamp to ground",
      type: "boolean",
      get: (s) => s.clampToGround,
      set: (s, v) => s.setClampToGround(v),
    },
    {
      name: "height",
      label: "Height",
      type: "distance",
      min: 0,
      get: (s) => s.height,
      set: (s, v) => s.setHeight(v),
    },
  ];

  /** Registers a subclass for {@link Shape.fromJSON}. */
  static register(ShapeClass) {
    registry.set(ShapeClass.type, ShapeClass);
    return ShapeClass;
  }

  static classFor(type) {
    return registry.get(type);
  }

  /**
   * @param {object} json From {@link Shape#toJSON}.
   * @param {object} [options]
   * @param {function} [options.resolveMaterial] Turns a non-color material `json` back into a
   *   material spec (see materialFromJSON).
   */
  static fromJSON(json, { resolveMaterial } = {}) {
    const ShapeClass = registry.get(json.type);
    if (!ShapeClass) {
      throw new Error(`Unknown shape type "${json.type}".`);
    }
    const markers = { ...json.markers };
    if (markers.pinColor) {
      markers.pinColor = Color.fromCssColorString(markers.pinColor);
    }
    return new ShapeClass({
      id: json.id,
      arcType: json.arcType === "RHUMB" ? ArcType.RHUMB : ArcType.GEODESIC,
      clampToGround: json.clampToGround,
      height: json.height,
      outline: {
        width: json.outline?.width,
        show: json.outline?.show,
        material: materialFromJSON(json.outline?.material, resolveMaterial),
      },
      fill: {
        show: json.fill?.show,
        material: materialFromJSON(json.fill?.material, resolveMaterial),
      },
      markers,
      properties: json.properties,
      cursorMessages: json.cursorMessages,
      ...ShapeClass.stateFromJSON(json),
    });
  }

  static stateFromJSON() {
    return {};
  }

  /**
   * @param {object} [options]
   * @param {string} [options.id]
   * @param {ArcType} [options.arcType=ArcType.GEODESIC] GEODESIC or RHUMB.
   * @param {boolean} [options.clampToGround=true] false = drawn at altitude.
   * @param {number} [options.height=0] Meters above the ellipsoid, at altitude: the height of
   *   single-height shapes and of new vertices.
   * @param {object} [options.outline] { material, width (pixels, default 2), show }.
   * @param {object} [options.fill] { material, show }. Ignored by shapes without a fill.
   * @param {object} [options.lineMaterials] { [lineKey]: material } for shapes with several
   *   kinds of lines; lines without an entry use outline.material.
   * @param {object} [options.markers] Marker options, see DEFAULT_MARKER_OPTIONS (Markers.js).
   * @param {object} [options.detail] Geometry detail overrides, see DEFAULT_DETAIL (geodesy.js).
   * @param {boolean} [options.show=true]
   * @param {object} [options.properties] Free user data, kept in toJSON.
   * @param {boolean|function} [options.cursorMessages=true] Message box at the mouse cursor
   *   (shown by the editor): true = the shape's own messages ("Click to set center" …, while
   *   drawing), false = none, or a function (shape) => text | undefined for your own.
   */
  constructor(options = {}) {
    this.id = options.id ?? `shape-${nextId++}`;
    this.editor = undefined;
    this.arcType = options.arcType ?? ArcType.GEODESIC;
    this.clampToGround = options.clampToGround ?? true;
    this.height = options.height ?? 0;
    this.outline = {
      material: toShapeMaterial(options.outline?.material) ?? colorMaterial(DEFAULT_OUTLINE_COLOR),
      width: options.outline?.width ?? 2,
      show: options.outline?.show ?? true,
    };
    this.fill = {
      material: toShapeMaterial(options.fill?.material) ?? colorMaterial(DEFAULT_FILL_COLOR),
      show: options.fill?.show ?? true,
    };
    this.lineMaterials = {};
    for (const [key, material] of Object.entries(options.lineMaterials ?? {})) {
      this.lineMaterials[key] = toShapeMaterial(material);
    }
    this.markerOptions = {
      ...DEFAULT_MARKER_OPTIONS,
      ...this.constructor.defaultMarkerOptions,
      ...options.markers,
    };
    this.detail = { ...DEFAULT_DETAIL, ...options.detail };
    this.properties = options.properties ?? {};
    this.cursorMessages = options.cursorMessages ?? true;

    /** Raised (with the shape) after the shape was rebuilt; at most once per frame. */
    this.changed = new Event();
    /** Raised with (shape, mode, previousMode). */
    this.modeChanged = new Event();

    this._mode = ShapeMode.IDLE;
    this._show = options.show ?? true;
    this._dirty = Dirty.GEOMETRY;
    this._interactive = false;
    this._fillPrimitive = undefined;
    this._linePrimitives = [];
    this._instances = new Map(); // "fill" | "line:<key>[:i]" -> { spec, instance }
    this._fillPositions = [];
    this._linePositions = [];
    this._markers = undefined;
    this.boundingSphere = undefined;
  }

  // --- Mode ----------------------------------------------------------------------------------

  get mode() {
    return this._mode;
  }

  /** Finishes drawing: enters EDIT_MODE if the shape is valid, otherwise removes it. */
  finishDrawing() {
    if (this._mode !== ShapeMode.DRAW) {
      return false;
    }
    if (!this.isValid()) {
      this.cancelDrawing();
      return false;
    }
    this.editor?._finishedDrawing(this);
    return true;
  }

  /** Abandons drawing and removes the shape. */
  cancelDrawing() {
    if (this._mode === ShapeMode.DRAW) {
      this.editor?.remove(this);
    }
  }

  /** Enters EDIT_MODE (and leaves it for any other shape). */
  edit() {
    this.editor?.select(this);
  }

  /** Leaves EDIT_MODE. */
  stopEditing() {
    if (this.editor?.selected === this) {
      this.editor.deselect();
    }
  }

  /** Removes the shape from its editor and frees everything it rendered. */
  remove() {
    this.editor?.remove(this);
  }

  // Called by the editor.
  _setMode(mode) {
    const previous = this._mode;
    if (mode === previous) {
      return;
    }
    this._mode = mode;
    this._interactive = false;
    if (mode === ShapeMode.IDLE) {
      this._markers?.destroy();
      this._markers = undefined;
    } else {
      this._markers ??= new MarkerSet(this.editor, this);
    }
    // Leaving DRAW_MODE: rebuild at full detail.
    this.invalidate(previous === ShapeMode.DRAW ? Dirty.GEOMETRY : Dirty.MARKERS);
    this.modeChanged.raiseEvent(this, mode, previous);
  }

  /** True while drawing or dragging: geometry is built coarser so it keeps up. */
  get interactive() {
    return this._mode === ShapeMode.DRAW || this._interactive;
  }

  _setInteractive(on) {
    if (this._interactive === on) {
      return;
    }
    this._interactive = on;
    if (!on) {
      this.invalidate(Dirty.GEOMETRY); // full detail again
    }
  }

  /** Geometry granularity multiplier (coarser while interactive). */
  get detailFactor() {
    return this.interactive ? this.detail.interactiveFactor : 1;
  }

  // --- Properties ----------------------------------------------------------------------------

  get show() {
    return this._show;
  }

  set show(value) {
    this._show = value;
    if (this._fillPrimitive) {
      this._fillPrimitive.show = value;
    }
    for (const primitive of this._linePrimitives) {
      primitive.show = value;
    }
    this.editor?.scene.requestRender();
  }

  setArcType(arcType) {
    this.arcType = arcType;
    this.invalidate(Dirty.GEOMETRY);
  }

  setOutlineMaterial(material) {
    this.outline.material = toShapeMaterial(material);
    this.invalidate(Dirty.OUTLINE);
  }

  setLineMaterial(key, material) {
    this.lineMaterials[key] = toShapeMaterial(material);
    this.invalidate(Dirty.OUTLINE);
  }

  setOutlineWidth(width) {
    this.outline.width = width;
    this.invalidate(Dirty.OUTLINE);
  }

  setOutlineShow(show) {
    this.outline.show = show;
    this.invalidate(Dirty.OUTLINE);
  }

  setFillMaterial(material) {
    this.fill.material = toShapeMaterial(material);
    this.invalidate(Dirty.FILL);
  }

  setFillShow(show) {
    this.fill.show = show;
    this.invalidate(Dirty.FILL);
  }

  /** true (built-in messages), false (none) or a function (shape) => text | undefined. */
  setCursorMessages(value) {
    this.cursorMessages = value;
    this.editor?._updateCursorMessage();
  }

  /**
   * The text for the message box at the mouse cursor right now, or undefined for none: what
   * the `cursorMessages` option gives (the editor shows it).
   */
  currentCursorMessage() {
    const option = this.cursorMessages;
    if (!option) {
      return undefined;
    }
    return typeof option === "function" ? option(this) : this.cursorMessage();
  }

  setMarkerOptions(options) {
    Object.assign(this.markerOptions, options);
    this._markers?.restyleAll();
    this.invalidate(Dirty.MARKERS);
  }

  setClampToGround(clampToGround) {
    this.clampToGround = clampToGround;
    this.invalidate(Dirty.GEOMETRY);
  }

  /** Sets the height (meters above the ellipsoid) used at altitude. */
  setHeight(height) {
    this.height = Math.max(height, 0);
    this.invalidate(Dirty.GEOMETRY);
  }

  /** Height new points get: 0 on the ground, `height` at altitude. */
  get pointHeight() {
    return this.clampToGround ? 0 : this.height;
  }

  /** `position` moved to the shape's point height. */
  atPointHeight(position) {
    return withHeight(position, this.pointHeight);
  }

  // --- Fields (for forms) --------------------------------------------------------------------

  /**
   * This shape's field descriptions, with `min` / `max` resolved for it (e.g. a polygon needs
   * 3 positions, a polyline 2). Descriptions without get / set functions are for display.
   */
  get fields() {
    return this.constructor.fields.map((field) => ({
      ...field,
      min: typeof field.min === "function" ? field.min(this) : field.min,
      max: typeof field.max === "function" ? field.max(this) : field.max,
    }));
  }

  #field(name) {
    const field = this.fields.find((f) => f.name === name);
    if (!field) {
      throw new Error(`${this.constructor.type} has no field "${name}".`);
    }
    return field;
  }

  /** A field's value in display units (degrees, meters); copies, safe to keep or modify. */
  getField(name) {
    return this.#field(name).get(this) ?? null;
  }

  /** { name: value } for every field. */
  getFields() {
    return Object.fromEntries(this.fields.map((f) => [f.name, f.get(this) ?? null]));
  }

  /**
   * Validates a value in display units, applies it (rebuilding the shape on the next frame)
   * and returns the value actually applied (after clamping). Throws with a readable message
   * for values that can't be used, such as a latitude of 95° or too few vertices.
   */
  setField(name, value) {
    const field = this.#field(name);
    field.set(this, validateField(field, value));
    return this.getField(name);
  }

  /** Marks parts of the shape for rebuilding on the next frame (see {@link Dirty}). */
  invalidate(flags = Dirty.GEOMETRY) {
    this._dirty |= flags;
    this.editor?._requestFlush(this);
  }

  // --- Hooks (override in subclasses) -------------------------------------------------------

  getControlPoints() {
    return [];
  }

  setControlPoints() {}

  isValid() {
    return false;
  }

  onDrawClick() {
    return "done";
  }

  onDrawMove() {}

  /** Double-click or right-click while drawing. Default: right-click cancels. */
  onDrawFinishRequest(kind) {
    if (kind === "right") {
      this.cancelDrawing();
    }
  }

  drawHint() {
    return "";
  }

  /**
   * Short instruction for the message box at the mouse cursor (e.g. "Click to set center"),
   * or undefined for none. Subclasses return one per DRAW_MODE step; may contain "\n".
   */
  cursorMessage() {
    return undefined;
  }

  markerSpecs() {
    return [];
  }

  onMarkerDrag() {}

  /** Shift+drag: default changes the whole shape's height. */
  onMarkerHeight(spec, height) {
    this.setHeight(height);
  }

  /** Current height of a marker, for shift+drag. */
  markerHeight(spec) {
    return heightOf(spec.position);
  }

  /** Deletes what a deletable marker stands for; false if refused. */
  deleteMarker() {
    return false;
  }

  createFillGeometry() {
    return undefined;
  }

  outlineLines() {
    return [];
  }

  stateToJSON() {
    return {};
  }

  /**
   * Moves the whole shape so that `from` ends up at `to`: rotates every control point about
   * the earth's center (keeping heights), so the shape keeps its size and form anywhere on
   * the globe.
   */
  translate(from, to) {
    this.setControlPoints(rotatePositions(this.getControlPoints(), from, to));
    this.invalidate(Dirty.GEOMETRY);
  }

  /** Where the translate marker sits (default: the control points' centroid). */
  translateAnchor() {
    const anchor = centroid(this.getControlPoints());
    return anchor && this.atPointHeight(anchor);
  }

  /** The translate marker spec, if translatable and editing (for markerSpecs). */
  translateSpec(position = this.translateAnchor()) {
    if (!position || !this.markerOptions.translatable || this._mode !== ShapeMode.EDIT) {
      return [];
    }
    return [{ key: "translate", position, role: "translate" }];
  }

  // --- Geometry helpers for subclasses ------------------------------------------------------

  /**
   * Fill geometry for a closed boundary. Edges follow the arc type and the surface follows
   * the earth's curvature, on the ground and at altitude (heights taken from the boundary).
   */
  polygonGeometry(boundary) {
    if (distinctCount(boundary) < 3) {
      return undefined;
    }
    // Copies: Cesium's polygon (and corridor) geometry projects the positions it's given onto
    // the ellipsoid in place, which would flatten the shape's own vertices.
    boundary = clonePositions(boundary);
    this._fillPositions = boundary;
    const options = {
      vertexFormat: TEXTURED.vertexFormat,
      granularity: polygonGranularity(boundary, this.detail, this.detailFactor),
      arcType: this.arcType,
    };
    // A wide polygon: bounding rectangle 180° or more across, e.g. around a pole.
    const wide = isWidePolygon(boundary, this.arcType);
    if (wide && this.arcType === ArcType.RHUMB) {
      // Cesium 1.122 never returns from building a wide RHUMB polygon (ground or not).
      // Trace the rhumb edges with short geodesic pieces instead.
      boundary = densify(boundary, ArcType.RHUMB, options.granularity * ellipsoid.maximumRadius, true);
      options.arcType = ArcType.GEODESIC;
    }
    if (!this.clampToGround) {
      // At altitude Cesium's PolygonGeometry can't be used as is: with perPositionHeight it
      // skips subdivision (straight chords, ignoring the arc type), large polygons come out
      // with every triangle twice (doubling a translucent fill), and wide ones (e.g. over a
      // pole) throw. createPolygonGeometry (liftedPolygon.js) works around all three.
      const heights = boundary.map(heightOf);
      const uniform = heights.every((h) => Math.abs(h - heights[0]) <= 1e-3);
      return createPolygonGeometry(boundary, {
        granularity: options.granularity,
        arcType: options.arcType,
        height: uniform ? heights[0] : undefined,
      });
    }
    // On the ground (GroundPrimitive) Cesium's own geometry is fine.
    return new PolygonGeometry({
      ...options,
      polygonHierarchy: new PolygonHierarchy(clonePositions(boundary)),
    });
  }

  // --- Rendering (called by the editor) -----------------------------------------------------

  _flush() {
    const dirty = this._dirty;
    this._dirty = 0;
    if (!this.editor) {
      return;
    }
    if (dirty & Dirty.FILL) {
      this.#rebuildFill();
    }
    if (dirty & Dirty.OUTLINE) {
      this.#rebuildLines();
    }
    if (dirty & (Dirty.FILL | Dirty.OUTLINE)) {
      const all = [...this._fillPositions, ...this._linePositions];
      this.boundingSphere = all.length > 0 ? BoundingSphere.fromPoints(all) : undefined;
    }
    if (this._markers && dirty & Dirty.MARKERS) {
      this._markers.sync(this.markerSpecs());
    }
    this.editor.scene.requestRender();
    const change = {
      fields: this.#changedFields(),
      source: this._mode === ShapeMode.DRAW ? "draw" : this._interactive ? "drag" : "api",
      interactive: this.interactive,
    };
    this.changed.raiseEvent(this, change);
    this.editor.shapeChanged.raiseEvent(this, change);
  }

  // Field names whose value differs from the last flush (all of them the first time).
  // Comparing snapshots catches every change (drawing, dragging, translating, setters,
  // subclasses) without each code path having to report what it touched.
  #changedFields() {
    const snapshot = {};
    const changed = [];
    for (const field of this.constructor.fields) {
      const value = JSON.stringify(field.get(this) ?? null);
      snapshot[field.name] = value;
      if (this._fieldSnapshot?.[field.name] !== value) {
        changed.push(field.name);
      }
    }
    this._fieldSnapshot = snapshot;
    return changed;
  }

  /** Per-frame material updates; returns true while a material is still loading images. */
  _updateFrame(scene, cullingVolume) {
    if (!this._show || this._instances.size === 0) {
      return false;
    }
    const visible =
      !this.boundingSphere ||
      cullingVolume.computeVisibility(this.boundingSphere) !== Intersect.OUTSIDE;
    let loading = false;
    for (const { instance } of this._instances.values()) {
      loading ||= Boolean(instance.loading);
      if (visible && instance.update) {
        instance.update(scene, this);
      }
    }
    return loading;
  }

  _destroyRender() {
    this.#removeFill();
    this.#removeLines();
    for (const { instance } of this._instances.values()) {
      instance.destroy();
    }
    this._instances.clear();
    this._markers?.destroy();
    this._markers = undefined;
  }

  get markers() {
    return this._markers;
  }

  #removeFill() {
    if (this._fillPrimitive) {
      this.editor.primitives.remove(this._fillPrimitive);
      this._fillPrimitive = undefined;
    }
  }

  #removeLines() {
    for (const primitive of this._linePrimitives) {
      this.editor.primitives.remove(primitive);
    }
    this._linePrimitives = [];
  }

  #instance(key, spec) {
    let entry = this._instances.get(key);
    if (entry && entry.spec !== spec) {
      entry.instance.destroy();
      entry = undefined;
    }
    if (!entry) {
      entry = { spec, instance: spec.create() };
      this._instances.set(key, entry);
    }
    return entry.instance;
  }

  #releaseUnused(prefix, used) {
    for (const [key, entry] of this._instances) {
      if (key.startsWith(prefix) && !used.has(key)) {
        entry.instance.destroy();
        this._instances.delete(key);
      }
    }
  }

  #rebuildFill() {
    this.#removeFill();
    this._fillPositions = [];
    const used = new Set();
    const spec = this.fill.material;
    if (this.constructor.hasFill && this.fill.show && spec) {
      const geometry = this.createFillGeometry();
      if (geometry) {
        used.add("fill");
        const instance = this.#instance("fill", this.clampToGround ? spec : altitudeFallback(spec));
        instance.setFill?.(this._fillPositions.length > 0 ? this._fillPositions : this.getControlPoints());
        const appearance = new MaterialAppearance({
          material: instance.material,
          materialSupport: TEXTURED,
          translucent: true,
          flat: true,
        });
        const geometryInstances = new GeometryInstance({
          geometry,
          id: { shape: this, part: "fill" },
        });
        const Type = this.clampToGround ? GroundPrimitive : Primitive;
        const primitive = new Type({ geometryInstances, appearance, asynchronous: false });
        primitive.show = this._show;
        this._fillPrimitive = this.editor.primitives.add(primitive);
      }
    }
    this.#releaseUnused("fill", used);
  }

  #rebuildLines() {
    this.#removeLines();
    this._linePositions = [];
    const used = new Set();
    if (this.outline.show) {
      const groups = new Map();
      for (const line of this.outlineLines()) {
        if (distinctCount(line.positions) < 2) {
          continue;
        }
        const key = line.key ?? "outline";
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key).push(line);
        this._linePositions.push(...line.positions);
      }
      for (const [key, lines] of groups) {
        let spec = this.lineMaterials[key] ?? this.outline.material;
        if (!spec) {
          continue;
        }
        if (!this.clampToGround) {
          spec = altitudeFallback(spec);
        }
        if (spec.stateful) {
          lines.forEach((line, i) => {
            const instanceKey = `line:${key}:${i}`;
            used.add(instanceKey);
            const instance = this.#instance(instanceKey, spec);
            const width = line.width ?? this.outline.width;
            const positions = this.#prepareStatefulLine(line, spec);
            const extras = instance.setLine?.(positions, width) ?? [];
            const arcType = spec.requiresGeodesicSegments ? ArcType.GEODESIC : this.arcType;
            this.#addLinePrimitive(instance.material, [
              { positions, width, loop: false, arcType },
              ...extras.map((e) => ({ positions: e.positions, width: e.width, loop: false, arcType })),
            ]);
          });
        } else {
          const instanceKey = `line:${key}`;
          used.add(instanceKey);
          const instance = this.#instance(instanceKey, spec);
          this.#addLinePrimitive(
            instance.material,
            lines.map((line) => ({
              positions: line.positions,
              width: line.width ?? this.outline.width,
              loop: Boolean(line.loop),
              arcType: this.arcType,
            })),
          );
        }
      }
    }
    this.#releaseUnused("line:", used);
  }

  // Stateful line materials take one open line: close loops by repeating the first point, and
  // approximate rhumb lines with short geodesic pieces when the material assumes geodesics.
  #prepareStatefulLine(line, spec) {
    let positions = line.positions;
    if (line.loop) {
      positions = [...positions, positions[0]];
    }
    if (spec.requiresGeodesicSegments && this.arcType === ArcType.RHUMB) {
      const length = lineLength(positions, ArcType.RHUMB);
      positions = densify(positions, ArcType.RHUMB, Math.max(length / 256, 500));
    }
    return positions;
  }

  #addLinePrimitive(material, lines) {
    const factor = this.detailFactor;
    const geometryInstances = lines.map((input) => {
      // Copies, so Cesium can never modify the shape's own positions (see polygonGeometry).
      const line = { ...input, positions: clonePositions(input.positions) };
      let geometry;
      if (this.clampToGround) {
        geometry = new GroundPolylineGeometry({
          positions: line.positions,
          width: line.width,
          loop: line.loop,
          arcType: line.arcType,
          granularity: lineGranularity(line.positions, line.loop, this.detail, factor),
        });
      } else {
        geometry = new PolylineGeometry({
          positions: line.loop ? [...line.positions, line.positions[0]] : line.positions,
          width: line.width,
          arcType: line.arcType,
          vertexFormat: PolylineMaterialAppearance.VERTEX_FORMAT,
          granularity: CesiumMath.RADIANS_PER_DEGREE * factor,
        });
      }
      return new GeometryInstance({ geometry, id: { shape: this, part: "outline" } });
    });
    const appearance = new PolylineMaterialAppearance({ material });
    const Type = this.clampToGround ? GroundPolylinePrimitive : Primitive;
    const primitive = new Type({ geometryInstances, appearance, asynchronous: false });
    primitive.show = this._show;
    this._linePrimitives.push(this.editor.primitives.add(primitive));
  }

  // --- Serialization ------------------------------------------------------------------------

  toJSON() {
    const o = this.markerOptions;
    return {
      type: this.constructor.type,
      id: this.id,
      arcType: this.arcType === ArcType.RHUMB ? "RHUMB" : "GEODESIC",
      clampToGround: this.clampToGround,
      height: this.height,
      outline: {
        width: this.outline.width,
        show: this.outline.show,
        material: this.outline.material?.json ?? null,
      },
      fill: { show: this.fill.show, material: this.fill.material?.json ?? null },
      markers: {
        deletable: o.deletable,
        numbered: o.numbered,
        translatable: o.translatable,
        groundLine: o.groundLine,
        pinSize: o.pinSize,
        pinColor: o.pinColor.toCssColorString(),
      },
      properties: this.properties,
      // Only true / false can be saved, not a function.
      ...(typeof this.cursorMessages === "boolean" ? { cursorMessages: this.cursorMessages } : {}),
      ...this.stateToJSON(),
    };
  }
}

/**
 * Checks and normalizes a field value in display units (see Shape.fields): numbers must be
 * finite and are clamped to min / max, positions need -90..90 latitudes, and position lists
 * need at least `min` entries. Throws an Error with a readable message otherwise.
 */
export function validateField(field, value) {
  const label = field.label ?? field.name;
  const number = (v, what = label) => {
    const n = typeof v === "string" ? Number(v.trim()) : v;
    if (typeof n !== "number" || !Number.isFinite(n) || (typeof v === "string" && v.trim() === "")) {
      throw new Error(`${what} must be a number.`);
    }
    return n;
  };
  const position = (v, what = label) => {
    if (!Array.isArray(v) || v.length < 2 || v.length > 3) {
      throw new Error(`${what} must be [longitude, latitude] or [longitude, latitude, height].`);
    }
    const lon = number(v[0], `${what} longitude`);
    const lat = number(v[1], `${what} latitude`);
    const blank = v[2] === undefined || v[2] === null || (typeof v[2] === "string" && v[2].trim() === "");
    const height = blank ? 0 : number(v[2], `${what} height`);
    if (lat < -90 || lat > 90) {
      throw new Error(`${what} latitude must be between -90 and 90.`);
    }
    return [CesiumMath.toDegrees(CesiumMath.negativePiToPi(CesiumMath.toRadians(lon))), lat, height];
  };
  switch (field.type) {
    case "number":
    case "distance":
    case "angle": {
      const n = number(value);
      return Math.min(Math.max(n, field.min ?? -Infinity), field.max ?? Infinity);
    }
    case "boolean":
      return Boolean(value);
    case "enum":
      if (!field.options.includes(value)) {
        throw new Error(`${label} must be one of ${field.options.join(", ")}.`);
      }
      return value;
    case "position":
      return position(value);
    case "positions": {
      if (!Array.isArray(value)) {
        throw new Error(`${label} must be a list of positions.`);
      }
      if (field.min !== undefined && value.length < field.min) {
        throw new Error(`${label} needs at least ${field.min} entries.`);
      }
      if (field.max !== undefined && value.length > field.max) {
        throw new Error(`${label} allows at most ${field.max} entries.`);
      }
      return value.map((v, i) => position(v, `${label} ${i + 1}`));
    }
    default:
      return value;
  }
}

/**
 * A position as a field value: [lon°, lat°, height m], rounded to 1e-10° (~0.01 mm) and
 * 0.1 mm so Cartesian round-trip noise (39.49999999999999, heights of 1e-9) doesn't show up
 * in forms or count as a change.
 */
export function fieldPosition(position) {
  const [lon, lat, height] = toDegrees(position);
  const round = (v, step) => Math.round(v / step) * step;
  return [+round(lon, 1e-10).toFixed(10), +round(lat, 1e-10).toFixed(10), +round(height, 1e-4).toFixed(4) || 0];
}

/** [lon°, lat°, height] of a position. */
export function toDegrees(position) {
  const c = toCartographic(position);
  return [CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude), c.height];
}

/** Position from [lon°, lat°, height?]. */
export function fromDegrees([lon, lat, height = 0]) {
  return Cartesian3.fromDegrees(lon, lat, height);
}

/**
 * Copies of positions. Pass these, never a shape's own positions, to Cesium geometry: some
 * geometries (PolygonGeometry without perPositionHeight, CorridorGeometry) move the positions
 * they're given onto the ellipsoid in place.
 */
export function clonePositions(positions) {
  return positions.map((p) => Cartesian3.clone(p));
}

// Number of distinct positions (up to 3, which is all callers need).
function distinctCount(positions) {
  const distinct = [];
  for (const p of positions) {
    if (!distinct.some((q) => Cartesian3.equalsEpsilon(p, q, 0, 1e-2))) {
      distinct.push(p);
      if (distinct.length >= 3) {
        break;
      }
    }
  }
  return distinct.length;
}
