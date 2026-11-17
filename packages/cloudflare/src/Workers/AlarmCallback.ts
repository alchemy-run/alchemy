import type * as cf from "@cloudflare/workers-types";
import { CallbackError, type CallbackFactory, Callbacks } from "alchemy/Callback";
import {
  type AlarmCallbackFactory,
  makeDurableObjectCallbackFactory as makeWorkerdCallbackFactory,
} from "alchemy/Workers/Workerd/AlarmCallback";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DurableObjectState } from "./DurableObjectState.ts";

export {
  dispatchAlarmCallbacks,
  initializeAlarmCallbacks,
  outsideAlarmPass,
} from "alchemy/Workers/Workerd/AlarmCallback";

/**
 * @internal The alarm callback factory of one instance, with the scheduler's
 * redelivery state and an optional policy override for tests.
 */
export const makeDurableObjectCallbackFactory = (
  raw: cf.DurableObjectState,
  random: SecureRandom.SecureRandom["Service"],
): AlarmCallbackFactory => makeWorkerdCallbackFactory(raw, DurableObjectState, random);

/**
 * Durable callbacks kept in a Durable Object's own SQLite storage and fired
 * from its alarm.
 *
 * Provide it to the inner, per-instance Effect of a Durable Object to use
 * `Alchemy.makeCallback` there. Register callbacks while the instance
 * initializes; each alarm runs the due jobs, routing each to the handler
 * registered under its callback name. Scheduling joins the current storage
 * transaction, so a job commits together with the state that needs it.
 *
 * ### Scheduling From A Durable Object
 * **Example:** Save State And Archive It Later
 * ```typescript
 * export default class Order extends Cloudflare.DurableObject<Order>()(
 *   "Order",
 *   Effect.gen(function* () {
 *     const archive = yield* Cloudflare.R2.WriteBucket(Archive);
 *     const state = yield* Cloudflare.DurableObjectState;
 *     return Effect.gen(function* () {
 *       const onArchive = yield* Alchemy.makeCallback(
 *         "archive",
 *         Effect.fn(function* ({ key, body }: { key: string; body: string }) {
 *           yield* archive.put(key, body).pipe(Effect.orDie);
 *         }),
 *       );
 *       return {
 *         save: Effect.fn(function* (id: string, body: string) {
 *           yield* state.storage.transaction(
 *             Effect.gen(function* () {
 *               yield* state.storage.put(id, body);
 *               yield* onArchive.schedule(id, { after: "30 seconds", payload: { key: id, body } });
 *             }),
 *           );
 *         }),
 *       };
 *     }).pipe(Effect.provide(Cloudflare.DurableObjectCallbacks));
 *   }).pipe(Effect.provide(Cloudflare.R2.WriteBucketBinding)),
 * ) {}
 * ```
 *
 * A job is acknowledged only after its handler succeeds. A recovery wake is
 * persisted before each attempt, so a handler that dies or an instance that
 * is evicted mid-run is redelivered: from 2 seconds doubling, then hourly,
 * and never dropped. Each alarm runs up to 100 due jobs. Calling `setAlarm`
 * or `deleteAlarm` directly bypasses the scheduler.
 *
 * @binding
 */
export const DurableObjectCallbacks = Layer.effect(
  Callbacks,
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    // Every Worker provides SecureRandom; read it optionally so a Durable
    // Object's instance needn't name it.
    const random = yield* Effect.serviceOption(SecureRandom.SecureRandom);
    if (random._tag === "None") {
      return yield* Effect.die(
        new CallbackError({ callback: "*", message: "DurableObjectCallbacks needs SecureRandom" }),
      );
    }
    const register = makeDurableObjectCallbackFactory(
      // `unknown` skips comparing the native state's two declarations.
      state.raw as unknown as cf.DurableObjectState,
      random.value,
    );
    const make: CallbackFactory = (name, handler) =>
      Effect.map(register(name, handler), (callback) => ({
        schedule: callback.schedule,
        cancel: callback.cancel,
        getStatus: (id: string) =>
          Effect.map(
            callback.getStatus(id),
            (status) => status && { scheduledAt: status.scheduledAt, progress: status.progress },
          ),
      }));
    return { make };
  }),
);
