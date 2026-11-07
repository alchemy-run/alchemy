/**
 * Layers a class's Construction phase hands to its runner, launched with the
 * runner's entities inside the cluster (with Sharding and the workflow
 * engine), on every runner of its pool.
 *
 * @internal
 */
import type * as Layer from "effect/Layer";

const layers: Array<Layer.Layer<never, never, any>> = [];

/** Launch `layer` in the cluster with this runner's entities. */
export const addClusterLayer = (layer: Layer.Layer<never, never, any>) => {
  layers.push(layer);
};

/** Every Layer the runner's classes handed it. */
export const clusterLayers = (): ReadonlyArray<Layer.Layer<never, never, any>> => layers;
