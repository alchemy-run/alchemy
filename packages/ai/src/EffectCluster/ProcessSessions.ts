/**
 * A process's sessions on Effect Cluster entities.
 *
 * @module
 */
import { layerObjectHost, type ObjectHostOptions } from "@alchemy.run/effect-cluster/ObjectHost";
import type { Providers } from "@alchemy.run/effect-cluster/Providers";
import * as Layer from "effect/Layer";
import { layerObjects } from "../Host.ts";

/**
 * Host a process on Effect Cluster: each session an entity id of one
 * entity, on whichever runner holds its shard, with its state in the
 * cluster's Postgres. `name` is the entity that holds the sessions, `main`
 * this file, and `pool` what runs it. Give it the process's Layer with
 * everything a session needs (its harness, model and tools). It gives back
 * the same process: `get(key)` is a handle on that session's entity.
 *
 * Export it as the file's default: the pool's runners load that to run the
 * sessions, and whatever serves the app imports it and provides it.
 *
 * It is `AI.layerObjects` on `Cluster.layerObjectHost`. Write those two out
 * to put a Domain model on the same host.
 *
 * ### Hosting a process on Effect Cluster
 * **Example:** An entity for each session
 * ```typescript
 * // src/Sessions.ts
 * import * as AICluster from "@alchemy.run/ai/EffectCluster";
 * import * as ClusterDocker from "@alchemy.run/effect-cluster/Docker";
 * import * as Layer from "effect/Layer";
 * import { Harness } from "./Harness.ts";
 * import { EngineerLive } from "./Engineer.process.ts";
 *
 * export const Database = ClusterDocker.Database("Cluster");
 * const Default = ClusterDocker.SwarmPool("Default").pipe(Layer.provide(Database));
 *
 * export default AICluster.ProcessSessions(
 *   "Sessions",
 *   { main: import.meta.url, pool: Default },
 *   EngineerLive.pipe(Layer.provide(Harness)),
 * );
 * ```
 *
 * @layer
 */
export const ProcessSessions = <A, E, R, PoolReq>(
  /** The entity that holds the sessions: its type in the cluster. */
  name: string,
  props: ObjectHostOptions<PoolReq>,
  layer: Layer.Layer<A, E, R>,
): Layer.Layer<A, E, Exclude<R, A> | PoolReq | Providers> =>
  layerObjects(layer).pipe(Layer.provide(layerObjectHost(name, props)));
