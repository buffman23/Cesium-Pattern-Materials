import { Color } from "cesium";

// Test images and styling shared by every solution so they can be compared like for like.
export const X_STAMP_URL = "/patterns/x-stamp.svg"; // 256 x 128: one stamp = 2x line width long
export const LINE_WIDTH = 24; // pixels
export const STAMP_SPACING = 1; // stamp repeat as a multiple of the stamp length (1 = touching)
export const LINE_COLOR = Color.fromCssColorString("#ffd400");

export const HATCH_URL = "/patterns/hatch-45.svg"; // 256 x 256
export const HATCH_TILE_PIXELS = 48; // approximate on-screen tile size
export const HATCH_COLOR = Color.fromCssColorString("#00e5ff");
