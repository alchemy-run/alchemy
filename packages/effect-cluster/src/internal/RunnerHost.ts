/**
 * What a runner's bootstrap knows while it builds its entrypoints: that it
 * is a runner, the entities Layers built there host (a Domain platform's
 * entity, built by the model's Layer rather than exported as a class), and
 * the Layers they hand it to launch inside the cluster (with Sharding and
 * the workflow engine), on every runner of the pool.
 *
 * @internal
 */
import type * as Layer from "effect/Layer";
import type { HostedEntity } from "../Entity.ts";

export const RunnerHost: {
  /** Set by the runner's bootstrap before it builds its entrypoints. */
  active: boolean;
  /** Entities hosted by Layers, in the order they were built. */
  readonly hosted: Array<HostedEntity>;
  /** Layers to launch in the cluster with the runner's entities. */
  readonly layers: Array<Layer.Layer<never, never, any>>;
} = { active: false, hosted: [], layers: [] };
