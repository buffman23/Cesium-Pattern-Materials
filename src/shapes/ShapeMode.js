/**
 * A shape's mode.
 *  - DRAW: the user is placing the points that define the shape.
 *  - EDIT: the shape shows markers that can be dragged (one shape at a time).
 *  - IDLE: finished and not being edited; click it to edit it again.
 */
const ShapeMode = Object.freeze({
  DRAW: "DRAW_MODE",
  EDIT: "EDIT_MODE",
  IDLE: "IDLE",
});

export default ShapeMode;
