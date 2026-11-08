import Shape from "./Shape.js";
import VertexShape from "./VertexShape.js";

/** Open line through its vertices; segments follow the shape's arcType. No fill. */
export default class Polyline extends VertexShape {
  static type = "Polyline";
  static hasFill = false;
  static insertOnDoubleClick = true;
  static minVertices = 2;

  outlineLines() {
    return [{ positions: this.drawPositions(), loop: false }];
  }
}

Shape.register(Polyline);
