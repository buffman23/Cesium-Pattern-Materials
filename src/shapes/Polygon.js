import Shape from "./Shape.js";
import VertexShape from "./VertexShape.js";

/** Closed area through its vertices; edges follow the shape's arcType. */
export default class Polygon extends VertexShape {
  static type = "Polygon";
  static minVertices = 3;

  createFillGeometry() {
    return this.polygonGeometry(this.drawPositions());
  }

  outlineLines() {
    const positions = this.drawPositions();
    return [{ positions, loop: positions.length >= 3 }];
  }
}

Shape.register(Polygon);
