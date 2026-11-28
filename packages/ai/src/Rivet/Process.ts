/**
 * A process's sessions on Rivet Durable Objects.
 *
 * @module
 */
import { layerObjectHost, type ObjectHostOptions } from "@alchemy.run/rivet/ObjectHost";
import type { Providers } from "@alchemy.run/rivet/Providers";
import * as Layer from "effect/Layer";
import { layerObjects } from "../Host.ts";

/**
 * Host a process on Rivet: each session in an actor of its own, named after
 * the session's key, with its own SQLite and alarm. `name` is the Durable
 * Object class that holds the sessions, `main` this file, and `pool` what
 * runs it. Give it the process's Layer with everything a session needs (its
 * harness, model and tools). It gives back the same process: `get(key)` is a
 * handle on that session's actor.
 *
 * Export it as the file's default: the pool's nodes load that to run the
 * sessions, and whatever serves the app imports it and provides it.
 *
 * It is `AI.layerObjects` on `Rivet.layerObjectHost`. Write those two out
 * to put a Domain model on the same host.
 *
 * ### Hosting a process on Rivet
 * **Example:** An actor for each session
 * ```typescript
 * // src/Sessions.ts
 * import * as AIRivet from "@alchemy.run/ai/Rivet";
 * import * as RivetDocker from "@alchemy.run/rivet/Docker";
 * import * as Layer from "effect/Layer";
 * import { Agents } from "./Agents.ts";
 * import { EngineerLive } from "./Engineer.process.ts";
 *
 * const ControlPlane = RivetDocker.SwarmControlPlane("Rivet");
 * const Default = RivetDocker.SwarmPool("Default").pipe(Layer.provide(ControlPlane));
 *
 * export default AIRivet.Process(
 *   "Sessions",
 *   { main: import.meta.url, pool: Default },
 *   EngineerLive.pipe(Layer.provide(Agents)),
 * );
 * ```
 *
 * ### With a Domain model
 * The model and the sessions share one host, so it is written once, below
 * both.
 *
 * **Example:** A model and its process on one class
 * ```typescript
 * // src/Live.ts
 * import * as AI from "@alchemy.run/ai";
 * import * as DomainRivet from "@alchemy.run/domain/Rivet";
 * import * as Rivet from "@alchemy.run/rivet";
 *
 * const WorkshopLive = Workshop.layer(TaskWorkLive).pipe(Layer.provide(DomainRivet.layerDurableObjects()));
 *
 * const EngineerSessions = AI.layerObjects(
 *   EngineerLive.pipe(Layer.provide(Layer.mergeAll(Agents, WorkshopLive))),
 * );
 *
 * export default WorkshopLive.pipe(
 *   Layer.provideMerge(EngineerSessions),
 *   Layer.provide(Rivet.layerObjectHost("Workshop", { main: import.meta.url, pool: Default })),
 * );
 * ```
 *
 * @layer
 */
export const Process = <A, E, R, PoolReq>(
  /** The Rivet Durable Object class that holds the sessions. */
  name: string,
  props: ObjectHostOptions<PoolReq>,
  layer: Layer.Layer<A, E, R>,
): Layer.Layer<A, E, Exclude<R, A> | PoolReq | Providers> =>
  layerObjects(layer).pipe(Layer.provide(layerObjectHost(name, props)));
