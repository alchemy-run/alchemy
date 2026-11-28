/**
 * A Durable Object for each session of a process.
 *
 * @module
 */
import {
  layerObjectHost,
  type ObjectHostOptions,
} from "@alchemy.run/cloudflare/Workers/ObjectHost";
import type { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import * as Layer from "effect/Layer";
import { layerObjects } from "../Host.ts";

/**
 * Host a process on Cloudflare Durable Objects: each session in an object
 * of its own, named after the session's key. Give it the process's Layer
 * with everything a session needs (its harness, model, tools, and the
 * Domain models its prose mentions). It gives back the same process:
 * `get(key)` is a handle on that session's object, and each call is an RPC
 * to it.
 *
 * The Worker that provides it declares one Durable Object class per
 * process, `AI.<Name>Process`. Each object builds the Layer for itself, so a
 * harness opens on that object's storage and alarm, and a session carries
 * on after its object is evicted.
 *
 * The options are `Cloudflare.layerObjectHost`'s: where the objects are
 * kept (`jurisdiction`, `locationHint`). To move the sessions to another
 * platform, use `AIRivet.layerDurableObjects` or `AICluster.layerEntities`
 * with the same Layer.
 *
 * The Layer may need the process it provides, as a Domain model whose
 * policy holds it does: this provides it, inside each object and out.
 *
 * ### Hosting a process
 * **Example:** A Durable Object for each session
 * ```typescript
 * import * as AI from "@alchemy.run/ai";
 * import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
 * import * as Pi from "@alchemy.run/pi";
 * import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
 * import * as Layer from "effect/Layer";
 * import { EngineerLive } from "./Engineer.process.ts";
 * import { Smart, SmartLive } from "./Models.ts";
 *
 * const Agents = Layer.mergeAll(Pi.HarnessLive, Pi.CodingTools, AI.DefaultModel(Smart)).pipe(
 *   Layer.provide(Layer.mergeAll(PiCloudflare.DurableObjectStorage, SmartLive)),
 * );
 *
 * export const EngineerSessions = AICloudflare.layerDurableObjects(
 *   EngineerLive.pipe(Layer.provide(Agents)),
 * );
 * ```
 *
 * ### With a Domain model
 * A model whose policy holds the process needs it, and the process's prose
 * needs the model. Leave the model needing the process, give it to the
 * prose, and provide the hosted process to the model.
 *
 * **Example:** A model and the process it hands work to
 * ```typescript
 * const WorkshopLive = Workshop.layer(TaskWorkLive).pipe(
 *   Layer.provide(DomainCloudflare.layerDurableObjects()),
 * );
 *
 * const EngineerSessions = AICloudflare.layerDurableObjects(
 *   EngineerLive.pipe(Layer.provide(Layer.mergeAll(Agents, WorkshopLive))),
 * );
 *
 * export const Live = WorkshopLive.pipe(Layer.provideMerge(EngineerSessions));
 * ```
 *
 * ### Reaching a session
 * Whatever the hosted Layer is provided to holds the process's client. Each
 * call goes to the object of the session it names. A session's live
 * `events` stay in its object: from outside, read `status` and `history`.
 *
 * **Example:** Send a session work, and read what it did
 * ```typescript
 * const engineer = yield* Engineer;
 * const session = engineer.get(taskId);
 *
 * yield* session.send("Rename the config flag.", { requestId: "start" });
 * const { status, queued } = yield* session.status;
 * const page = yield* session.history({ after: lastSeq, take: 100 });
 * ```
 *
 * @layer
 */
export const layerDurableObjects = <A, E, R>(
  layer: Layer.Layer<A, E, R>,
  options?: ObjectHostOptions,
): Layer.Layer<A, E, Exclude<R, A> | Worker> =>
  layerObjects(layer).pipe(Layer.provide(layerObjectHost(options)));
