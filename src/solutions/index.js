import createWorldSpaceRenderer from "./worldSpace/renderer.js";

/**
 * Candidate implementations of the pattern materials. Each `createRenderer(viewer)` returns
 * (or resolves to) { update(shape), remove(shape), destroy() }.
 */
export default [
  {
    id: "worldSpace",
    label: "World space (ground clamped)",
    description:
      "Shapes drape on the globe. X's are anchored to the line at constant pixel size; " +
      "hatch is anchored to the ground and adapts its density to the zoom level.",
    createRenderer: createWorldSpaceRenderer,
  },
];
