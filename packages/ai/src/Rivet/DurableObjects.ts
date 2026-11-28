/**
 * A Rivet Durable Object for each session of a process.
 *
 * @module
 */
import { layerObjectHost, type ObjectHostOptions } from "@alchemy.run/rivet/ObjectHost";
import type { Providers } from "@alchemy.run/rivet/Providers";
import * as Layer from "effect/Layer";
import { layerObjects } from "../Host.ts";

/**
 * Host a process on Rivet Durable Objects: each session in an object of its
 * own, named after the session's key. Give it the process's Layer with
 * everything a session needs (its harness, model, tools, and the Domain
 * models its prose mentions). It gives back the same process: `get(key)` is
 * a handle on that session's object, and each call goes to it through the
 * control plane's gateway.
 *
 * `name` is the Durable Object class that holds the sessions. The options
 * are `Rivet.layerObjectHost`'s: the pool's nodes load the hosted Layer
 * from `main`.
 *
 * The Layer may need the process it provides, as a Domain model whose
 * policy holds it does: this provides it, inside each object and out.
 *
 * ### Hosting a process on Rivet
 * **Example:** A Rivet Durable Object for each session
 * ```typescript
 * import * as AIRivet from "@alchemy.run/ai/Rivet";
 * import * as RivetDocker from "@alchemy.run/rivet/Docker";
 * import * as Layer from "effect/Layer";
 * import { Agents } from "./Agents.ts";
 * import { EngineerLive } from "./Engineer.process.ts";
 *
 * const ControlPlane = RivetDocker.SwarmControlPlane("Rivet");
 * const Default = RivetDocker.SwarmPool("Default").pipe(Layer.provide(ControlPlane));
 *
 * export const EngineerSessions = AIRivet.layerDurableObjects(
 *   "Sessions",
 *   EngineerLive.pipe(Layer.provide(Agents)),
 *   {
 *     main: import.meta.url,
 *     handler: "EngineerSessions",
 *     pool: Default,
 *   },
 * );
 * ```
 *
 * ### Moving from Cloudflare
 * The process's Layer is the same on every platform. Only the host changes.
 *
 * **Example:** The same sessions on Cloudflare and on Rivet
 * ```typescript
 * const Sessions = EngineerLive.pipe(Layer.provide(Agents));
 *
 * const OnCloudflare = AICloudflare.layerDurableObjects(Sessions);
 * const OnRivet = AIRivet.layerDurableObjects("Sessions", Sessions, {
 *   main: import.meta.url,
 *   handler: "OnRivet",
 *   pool: Default,
 * });
 * ```
 *
 * @layer
 */
export const layerDurableObjects = <A, E, R, PoolReq>(
  /** The Rivet Durable Object class that holds the sessions. */
  name: string,
  layer: Layer.Layer<A, E, R>,
  options: ObjectHostOptions<PoolReq>,
): Layer.Layer<A, E, Exclude<R, A> | PoolReq | Providers> =>
  layerObjects(layer).pipe(Layer.provide(layerObjectHost(name, options)));
