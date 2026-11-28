/**
 * An Effect Cluster entity for each session of a process.
 *
 * @module
 */
import { layerObjectHost, type ObjectHostOptions } from "@alchemy.run/effect-cluster/ObjectHost";
import type { Providers } from "@alchemy.run/effect-cluster/Providers";
import * as Layer from "effect/Layer";
import { layerObjects } from "../internal/hosted.ts";

/**
 * Host a process on Effect Cluster: each session an entity id of one
 * entity, on whichever runner holds its shard. Give it the process's Layer
 * with everything a session needs (its harness, model, tools, and the
 * Domain models its prose mentions). It gives back the same process:
 * `get(key)` is a handle on that session's entity.
 *
 * The options are the Effect Cluster object host's: `name` is the entity
 * that holds the sessions, and the pool's runners load the hosted Layer
 * from `main`.
 *
 * The Layer may need the process it provides, as a Domain model whose
 * policy holds it does: this provides it, inside each entity and out.
 *
 * ### Hosting a process on Effect Cluster
 * **Example:** An entity for each session
 * ```typescript
 * import * as AICluster from "@alchemy.run/ai/EffectCluster";
 * import * as ClusterDocker from "@alchemy.run/effect-cluster/Docker";
 * import * as Layer from "effect/Layer";
 * import { Agents } from "./Agents.ts";
 * import { EngineerLive } from "./Engineer.process.ts";
 *
 * export const Database = ClusterDocker.Database("Cluster");
 * const Default = ClusterDocker.SwarmPool("Default").pipe(Layer.provide(Database));
 *
 * export const EngineerSessions = AICluster.layerEntities(
 *   EngineerLive.pipe(Layer.provide(Agents)),
 *   {
 *     name: "Sessions",
 *     main: import.meta.url,
 *     handler: "EngineerSessions",
 *     pool: Default,
 *   },
 * );
 * ```
 *
 * @layer
 */
export const layerEntities = <A, E, R, PoolReq>(
  layer: Layer.Layer<A, E, R>,
  options: ObjectHostOptions<PoolReq>,
): Layer.Layer<A, E, Exclude<R, A> | PoolReq | Providers> =>
  layerObjects(layer).pipe(Layer.provide(layerObjectHost(options)));
