/**
 * A Durable Object for each session of a process.
 *
 * @module
 */
import { DurableObjectCallbacks } from "@alchemy.run/cloudflare/Workers/AlarmCallback";
import {
  DurableObject,
  type InlineDurableObjectProps,
} from "@alchemy.run/cloudflare/Workers/DurableObject";
import type { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import type { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Host from "../Host.ts";

interface SessionObject {
  readonly call: (
    key: string,
    method: string,
    args: ReadonlyArray<unknown>,
  ) => Effect.Effect<unknown, unknown, RuntimeContext>;
}

/**
 * Declare a Durable Object class on the host Worker from inside a Layer.
 * The inline form of `Cloudflare.DurableObject` is typed for single-stage
 * implementations, so it is re-typed here for the two-stage form it runs.
 */
const declare = DurableObject as unknown as (
  name: string,
  props: InlineDurableObjectProps,
  impl: Effect.Effect<
    Effect.Effect<SessionObject, never, DurableObjectState | RuntimeContext | Scope.Scope>,
    never,
    DurableObjectState
  >,
) => Effect.Effect<{ readonly getByName: (name: string) => SessionObject }, never, Worker>;

/**
 * How long to keep retrying a call that failed in transit: an object being
 * reset reports an opaque error, and for a while after a deploy some
 * objects still run the previous code. About a minute in total.
 */
const TRANSIT_RETRY = {
  schedule: Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("2 seconds")]),
  times: 35,
} as const;

/**
 * Host a process on Cloudflare Durable Objects: each session in an object
 * of its own, named after the session's key. Give it the process's Layer
 * with everything a session needs (its harness, model, tools, and the
 * Domain models its prose mentions). It gives back the same process:
 * `get(key)` is a handle on that session's object, and each call is an RPC
 * to it.
 *
 * The Worker that provides it declares one Durable Object class per
 * process, `<Name>Process`. Each object builds the Layer for itself, so a
 * harness opens on that object's storage and alarm, and a session carries
 * on after its object is evicted.
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
): Layer.Layer<A, E, Exclude<R, A> | Worker> =>
  Host.make(layer, (name, instance) =>
    Effect.map(
      declare(
        `${name}Process`.replace(/[^A-Za-z0-9_]/g, "_"),
        {},
        Effect.succeed(
          // A harness schedules its wake-ups on the object's alarm.
          instance({ apart: true }).pipe(Effect.provide(DurableObjectCallbacks)),
        ),
      ),
      (namespace): Host.Instances => ({
        call: (key, method, args) =>
          namespace
            .getByName(key)
            .call(key, method, args)
            .pipe(
              Effect.catchDefect((defect) => Effect.fail(defect)),
              Effect.retry(TRANSIT_RETRY),
              Effect.orDie,
            ),
      }),
    ),
  );
