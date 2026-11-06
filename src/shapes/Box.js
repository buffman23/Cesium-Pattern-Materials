import { Cartesian3, Math as CesiumMath } from "cesium";
import Shape, { Dirty, fieldPosition, fromDegrees, toDegrees } from "./Shape.js";
import ShapeMode from "./ShapeMode.js";
import { WIDTH_COLOR, coloredMarkerImage } from "./Markers.js";
import {
  arrivalBearing,
  bearing,
  crossTrackDistance,
  destination,
  distance,
  interpolate,
  rotatePositions,
} from "./geodesy.js";

const HALF_PI = CesiumMath.PI_OVER_TWO;

/** The two ways a Box can be defined (see Box). */
export const BoxForm = Object.freeze({ ANCHORS: "anchors", CENTER: "center" });

/**
 * A rotatable box: a centerline from `anchor1` to `anchor2` (the midpoints of the two short
 * ends), `width` across it, half to each side. Edges follow the shape's arcType.
 *
 * One stored geometry (center, length, width, heading) with two forms on top, which only
 * change how the box is drawn, edited and described as fields:
 *  - BoxForm.ANCHORS: anchor1, anchor2, width. Drawn by clicking anchor 1, anchor 2, then the
 *    width. Dragging an anchor moves that end; the other end stays put.
 *  - BoxForm.CENTER: center, length, width, heading (degrees clockwise from north, along the
 *    length). Drawn by clicking the center, a point that sets the length and direction, then
 *    the width. Dragging an end changes the length and rotates the box about the center.
 * Both have width markers on the long sides and a translate marker at the center. Switch with
 * setForm at any time; the box stays where it is. One height for the whole box at altitude.
 */
export default class Box extends Shape {
  static type = "Box";

  // Yellow squares change the width. The center form's ends (rotate and lengthen) use the
  // default rotate icon (role "end"); the anchor form's anchors stay white squares.
  static defaultMarkerOptions = {
    roleStyles: {
      width: { image: coloredMarkerImage(WIDTH_COLOR), width: 12, height: 12, align: false },
    },
  };

  static fields = [
    ...super.fields,
    {
      name: "form",
      label: "Defined by",
      type: "enum",
      options: [BoxForm.ANCHORS, BoxForm.CENTER],
      get: (s) => s.form,
      set: (s, v) => s.setForm(v),
    },
    {
      name: "anchor1",
      label: "Anchor 1",
      type: "position",
      show: (s) => s.form === BoxForm.ANCHORS,
      get: (s) => (s.center ? fieldPosition(s.anchors()[0]) : null),
      set: (s, v) => s.setAnchor1(fromDegrees(v)),
    },
    {
      name: "anchor2",
      label: "Anchor 2",
      type: "position",
      show: (s) => s.form === BoxForm.ANCHORS,
      get: (s) => (s.center ? fieldPosition(s.anchors()[1]) : null),
      set: (s, v) => s.setAnchor2(fromDegrees(v)),
    },
    {
      name: "center",
      label: "Center",
      type: "position",
      show: (s) => s.form === BoxForm.CENTER,
      get: (s) => s.center && fieldPosition(s.center),
      set: (s, v) => s.setCenter(fromDegrees(v)),
    },
    {
      name: "length",
      label: "Length",
      type: "distance",
      min: 0,
      show: (s) => s.form === BoxForm.CENTER,
      get: (s) => s.length,
      set: (s, v) => s.setLength(v),
    },
    {
      name: "width",
      label: "Width",
      type: "distance",
      min: 0,
      get: (s) => s.width,
      set: (s, v) => s.setWidth(v),
    },
    {
      name: "heading",
      label: "Heading",
      type: "angle",
      show: (s) => s.form === BoxForm.CENTER,
      get: (s) => +CesiumMath.toDegrees(CesiumMath.zeroToTwoPi(s.heading)).toFixed(9) % 360,
      set: (s, v) => s.setHeading(CesiumMath.toRadians(v)),
    },
  ];

  /**
   * @param {object} [options] Shape options, plus:
   * @param {string} [options.form=BoxForm.ANCHORS]
   * @param {Cartesian3} [options.anchor1] With anchor2: the box's centerline (takes precedence
   *   over center / length / heading).
   * @param {Cartesian3} [options.anchor2]
   * @param {Cartesian3} [options.center]
   * @param {number} [options.length=0] Meters.
   * @param {number} [options.width=0] Meters.
   * @param {number} [options.heading=0] Radians clockwise from north.
   */
  constructor(options = {}) {
    super(options);
    this.form = options.form === BoxForm.CENTER ? BoxForm.CENTER : BoxForm.ANCHORS;
    this.center = options.center && Cartesian3.clone(options.center);
    this.length = options.length ?? 0;
    this.width = options.width ?? 0;
    this.heading = options.heading ?? 0;
    if (options.anchor1 && options.anchor2) {
      this.#fromAnchors(options.anchor1, options.anchor2);
    }
    this._drawStep = this.center ? 3 : 0; // 0: first point, 1: second point, 2: width
    this._firstAnchor = undefined; // anchor form, while drawing
  }

  static stateFromJSON(json) {
    return {
      form: json.form,
      center: json.center && fromDegrees(json.center),
      length: json.length,
      width: json.width,
      heading: CesiumMath.toRadians(json.heading ?? 0),
    };
  }

  stateToJSON() {
    return {
      form: this.form,
      center: this.center && toDegrees(this.center),
      length: this.length,
      width: this.width,
      heading: CesiumMath.toDegrees(this.heading),
    };
  }

  // --- Geometry ----------------------------------------------------------------------------

  /** [anchor1, anchor2] at the shape's point height (both the center while length is 0). */
  anchors() {
    if (!this.center) {
      return [];
    }
    const h = this.pointHeight;
    const half = this.length / 2;
    return [
      destination(this.center, this.heading + Math.PI, half, this.arcType, h),
      destination(this.center, this.heading, half, this.arcType, h),
    ];
  }

  // Sets the stored geometry from a centerline.
  #fromAnchors(a1, a2) {
    this.length = distance(a1, a2, this.arcType);
    if (this.length > 0) {
      this.center = interpolate(a1, a2, 0.5, this.arcType);
      this.heading = bearing(this.center, a2, this.arcType);
    } else {
      this.center = Cartesian3.clone(a1);
    }
  }

  /** Corners in order: left of anchor1, left of anchor2, right of anchor2, right of anchor1. */
  corners() {
    if (!this.isValid()) {
      return [];
    }
    const [a1, a2] = this.anchors();
    const half = this.width / 2;
    const b1 = bearing(a1, a2, this.arcType); // direction along the box at anchor 1
    const b2 = arrivalBearing(a1, a2, this.arcType); // ... and at anchor 2
    return [
      destination(a1, b1 - HALF_PI, half, this.arcType),
      destination(a2, b2 - HALF_PI, half, this.arcType),
      destination(a2, b2 + HALF_PI, half, this.arcType),
      destination(a1, b1 + HALF_PI, half, this.arcType),
    ];
  }

  /** Width from a point beside the centerline: twice its distance across the centerline. */
  #widthAt(position) {
    const [a1, a2] = this.anchors();
    return 2 * Math.abs(crossTrackDistance(position, a1, a2, this.arcType));
  }

  isValid() {
    return Boolean(this.center) && this.length > 0 && this.width > 0;
  }

  createFillGeometry() {
    return this.isValid() ? this.polygonGeometry(this.corners()) : undefined;
  }

  outlineLines() {
    if (this.isValid()) {
      return [{ positions: this.corners(), loop: true }];
    }
    // While drawing, before the width is set: the centerline.
    return this.center && this.length > 0 ? [{ positions: this.anchors(), loop: false }] : [];
  }

  // --- Setters -----------------------------------------------------------------------------

  /** BoxForm.ANCHORS or BoxForm.CENTER; the box stays where it is. */
  setForm(form) {
    this.form = form === BoxForm.CENTER ? BoxForm.CENTER : BoxForm.ANCHORS;
    this.invalidate(Dirty.MARKERS);
  }

  setCenter(center) {
    this.center = Cartesian3.clone(center);
    this.invalidate(Dirty.GEOMETRY);
  }

  setLength(length) {
    this.length = Math.max(length, 0);
    this.invalidate(Dirty.GEOMETRY);
  }

  setWidth(width) {
    this.width = Math.max(width, 0);
    this.invalidate(Dirty.GEOMETRY);
  }

  /** Radians clockwise from north, along the length (anchor1 → anchor2). */
  setHeading(heading) {
    this.heading = heading;
    this.invalidate(Dirty.GEOMETRY);
  }

  setAnchors(anchor1, anchor2) {
    this.#fromAnchors(anchor1, anchor2);
    this.invalidate(Dirty.GEOMETRY);
  }

  /** Moves anchor 1; anchor 2 stays put. */
  setAnchor1(anchor) {
    const [, a2] = this.anchors();
    this.setAnchors(anchor, a2 ?? anchor);
  }

  /** Moves anchor 2; anchor 1 stays put. */
  setAnchor2(anchor) {
    const [a1] = this.anchors();
    this.setAnchors(a1 ?? anchor, anchor);
  }

  // --- Translate (same in both forms) --------------------------------------------------------

  getControlPoints() {
    return this.anchors();
  }

  setControlPoints([a1, a2]) {
    if (a1 && a2) {
      this.#fromAnchors(a1, a2);
    }
  }

  translateAnchor() {
    return this.center && this.atPointHeight(this.center);
  }

  /**
   * Moves the center and turns the heading with the same rotation about the earth's center,
   * keeping length and width exact (rotating the anchors themselves would change the length
   * slightly, as the earth isn't a sphere).
   */
  translate(from, to) {
    if (!this.center) {
      return;
    }
    const [, a2] = this.anchors();
    const [center, anchor2] = rotatePositions([this.center, a2], from, to);
    this.center = center;
    if (this.length > 0) {
      this.heading = bearing(center, anchor2, this.arcType);
    }
    this.invalidate(Dirty.GEOMETRY);
  }

  // --- Drawing -----------------------------------------------------------------------------

  onDrawClick(position) {
    this.#drawTo(position);
    if (this._drawStep === 0) {
      this._firstAnchor = position;
      this.center = Cartesian3.clone(position);
      this.length = 0;
      this.width = 0;
      this._drawStep = 1;
    } else if (this._drawStep === 1) {
      if (!(this.length > 0)) {
        return "continue"; // same point again: wait for a real second point
      }
      this._drawStep = 2;
    } else {
      if (!(this.width > 0)) {
        return "continue";
      }
      this._drawStep = 3;
      return "done";
    }
    this.invalidate(Dirty.GEOMETRY);
    return "continue";
  }

  onDrawMove(position) {
    if (this._drawStep > 0) {
      this.#drawTo(position);
    }
  }

  // Applies the cursor position to the current drawing step.
  #drawTo(position) {
    if (this._drawStep === 1) {
      if (this.form === BoxForm.ANCHORS) {
        this.#fromAnchors(this._firstAnchor, position);
      } else {
        this.length = 2 * distance(this.center, position, this.arcType);
        this.heading = bearing(this.center, position, this.arcType);
      }
      this.invalidate(Dirty.GEOMETRY);
    } else if (this._drawStep === 2) {
      this.width = this.#widthAt(position);
      this.invalidate(Dirty.GEOMETRY);
    }
  }

  cursorMessage() {
    if (this._mode !== ShapeMode.DRAW) {
      return undefined;
    }
    const steps =
      this.form === BoxForm.ANCHORS
        ? ["Click to set anchor 1", "Click to set anchor 2", "Click to set width"]
        : ["Click to set center", "Click to set length and direction", "Click to set width"];
    return steps[this._drawStep];
  }

  drawHint() {
    const steps =
      this.form === BoxForm.ANCHORS
        ? ["click anchor 1 (one end of the box)", "click anchor 2 (the other end)", "move sideways and click to set the width"]
        : ["click the center", "click to set the length and direction", "move sideways and click to set the width"];
    return steps[this._drawStep] ? `Drawing Box: ${steps[this._drawStep]}. Esc cancels.` : "";
  }

  // --- Markers -----------------------------------------------------------------------------

  markerSpecs() {
    if (!this.center) {
      return [];
    }
    const center = this.atPointHeight(this.center);
    const [a1, a2] = this.anchors();
    const anchors = this.form === BoxForm.ANCHORS;
    if (this._mode !== ShapeMode.EDIT) {
      // While drawing: just the point(s) placed so far.
      const first = anchors ? a1 : center;
      const specs = [{ key: anchors ? "anchor1" : "center", position: first, role: "point" }];
      if (anchors && this._drawStep >= 2) {
        specs.push({ key: "anchor2", position: a2, role: "point" });
      }
      return specs;
    }
    const numbered = this.markerOptions.numbered;
    const specs = anchors
      ? [
          { key: "anchor1", position: a1, role: "anchor", index: 0, label: numbered ? 1 : undefined },
          { key: "anchor2", position: a2, role: "anchor", index: 1, label: numbered ? 2 : undefined },
        ]
      : [
          { key: "end1", position: a1, role: "end", index: 0 },
          { key: "end2", position: a2, role: "end", index: 1 },
        ];
    const half = this.width / 2;
    if (this.length > 0) {
      for (const [key, side] of [["side1", -HALF_PI], ["side2", HALF_PI]]) {
        const bearingOut = this.heading + side;
        const position = destination(center, bearingOut, half, this.arcType);
        // axis: the direction the width changes in, at the marker (for the resize icon).
        const axis = half > 0 ? arrivalBearing(center, position, this.arcType) : bearingOut;
        specs.push({ key, position, role: "width", axis });
      }
    }
    specs.push(...this.translateSpec(center));
    return specs;
  }

  onMarkerDrag(spec, position) {
    if (spec.role === "anchor") {
      const [a1, a2] = this.anchors();
      this.setAnchors(spec.index === 0 ? position : a1, spec.index === 0 ? a2 : position);
    } else if (spec.role === "end") {
      // The center stays; the dragged end sets the half length and the direction.
      this.length = 2 * distance(this.center, position, this.arcType);
      const toward = bearing(this.center, position, this.arcType);
      this.heading = spec.index === 1 ? toward : toward + Math.PI;
      this.invalidate(Dirty.GEOMETRY);
    } else if (spec.role === "width") {
      this.setWidth(this.#widthAt(position));
    }
  }
}

Shape.register(Box);
