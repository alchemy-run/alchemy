import { Callbacks } from "alchemy/Callback";
import { storageCallbacks } from "alchemy/Workers/StorageCallbacks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CallbackHostId, DurableObjectState } from "./DurableObjectState.ts";

/**
 * Durable callbacks on a Rivet Durable Object, for `Alchemy.makeCallback`.
 *
 * Provide it to a Durable Object's instance Effect and register callbacks
 * while the instance is built. Jobs are rows in a table of the instance's
 * own, apart from `state.storage`, and a RivetKit schedule of their own
 * wakes the instance when one is due, so they never take the instance's
 * `alarm`. A job scheduled inside `state.storage.transaction(...)` commits or
 * rolls back with it.
 *
 * ### Calling an Instance Back Later
 * **Example:** Expire a reservation an hour after it is made
 * ```typescript
 * export default class Reservations extends Rivet.DurableObject<Reservations>()(
 *   "Reservations",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       const expire = yield* Alchemy.makeCallback(
 *         "expire",
 *         Effect.fn(function* (id: string) {
 *           yield* release(id);
 *         }),
 *       );
 *       return {
 *         reserve: Effect.fn(function* (id: string) {
 *           yield* hold(id);
 *           yield* expire.schedule(id, { after: "1 hour", payload: id });
 *         }),
 *       };
 *     }).pipe(Effect.provide(Rivet.DurableObjectCallbacks));
 *   }),
 * ) {}
 * ```
 *
 * ### Recurring Jobs
 * **Example:** Sweep every ten seconds and report every morning
 * ```typescript
 * export default class Sweeper extends Rivet.DurableObject<Sweeper>()(
 *   "Sweeper",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       const sweep = yield* Alchemy.makeCallback(
 *         "sweep",
 *         Effect.fn(function* () {
 *           yield* Effect.log("sweeping");
 *         }),
 *       );
 *       const report = yield* Alchemy.makeCallback(
 *         "report",
 *         Effect.fn(function* () {
 *           yield* Effect.log("daily report");
 *         }),
 *       );
 *       return {
 *         start: Effect.fn(function* () {
 *           yield* sweep.schedule("tick", { every: "10 seconds", payload: undefined });
 *           yield* report.schedule("daily", {
 *             cron: "0 9 * * *",
 *             timeZone: "Europe/London",
 *             payload: undefined,
 *           });
 *         }),
 *       };
 *     }).pipe(Effect.provide(Rivet.DurableObjectCallbacks));
 *   }),
 * ) {}
 * ```
 *
 * Delivery is at least once, so handlers must be idempotent. A run whose
 * handler fails is redelivered from 2 seconds doubling to hourly, and a
 * recurring job moves to its next run only once it succeeds.
 *
 * @binding
 */
export const DurableObjectCallbacks: Layer.Layer<Callbacks, never, DurableObjectState> =
  Layer.unwrap(
    Effect.gen(function* () {
      const host = (yield* DurableObjectState)[CallbackHostId];
      const { callbacks, fire } = storageCallbacks(host.storage, host.wake);
      host.onWake(fire);
      return callbacks;
    }),
  );
