/**
 * What a platform built on Effect Cluster entities, such as
 * `@alchemy.run/domain/EffectCluster`, needs from the runner it is built on
 * and from the gateway its callers reach entities through.
 *
 * @module
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { HostedEntity } from "./Entity.ts";

export { type GatewayTarget, makeNamespace } from "./internal/Gateway.ts";
export { HasNoPool } from "./internal/HostedRuntime.ts";

/**
 * The runner a Layer is being built on. A runner's bootstrap provides it
 * while it builds its entrypoints, so a Layer that hosts an entity itself
 * (a Domain platform's, built by the model's Layer rather than exported as
 * a class) hands the runner that entity, and the Layer to launch with it
 * inside the cluster (with Sharding and the workflow engine). Anywhere
 * else, the service is absent.
 */
export class RunnerHost extends Context.Service<
  RunnerHost,
  {
    /** Host an entity on this runner, launching `layer` in the cluster beside it. */
    readonly host: (
      entity: HostedEntity,
      layer: Layer.Layer<never, never, any>,
    ) => Effect.Effect<void>;
  }
>()("Cluster.RunnerHost") {}
