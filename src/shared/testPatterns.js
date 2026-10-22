import { Color } from "cesium";

// Test images and styling for the demo.

// Line images: one seamless period each, repeated along the line between the vertices.
export const LINE_IMAGES = {
  solid: "/patterns/line-solid.svg",
  dashed: "/patterns/line-dashed.svg",
  wave: "/patterns/line-wave.svg",
  sawtooth: "/patterns/line-sawtooth.svg",
  bottom: "/patterns/line-bottom.svg",
};

// Stamp images: symbols on a transparent background, drawn on top of the line.
export const STAMP_IMAGES = {
  x: "/patterns/x-symbol.svg",
  arrow: "/patterns/arrow-symbol.svg",
};

export const DEFAULT_LINE_IMAGE = "solid";
export const DEFAULT_STAMP_IMAGE = "x";
export const LINE_WIDTH = 24; // pixels
export const LINE_COLOR = Color.fromCssColorString("#ffd400");
export const STAMP_COLOR = Color.fromCssColorString("#ffd400");
export const STAMP_SPACING = 1; // stamp repeat as a multiple of the stamp length (1 = touching)

// Polygon fill images: seamless 256 x 256 tiles, repeated across the polygon.
export const POLYGON_IMAGES = {
  hatch: "/patterns/hatch-45.svg",
  dots: "/patterns/dots.svg",
  checkers: "/patterns/checkers.svg",
};

export const DEFAULT_POLYGON_IMAGE = "hatch";
export const HATCH_TILE_PIXELS = 48; // approximate on-screen tile size
export const HATCH_COLOR = Color.fromCssColorString("#00e5ff");
