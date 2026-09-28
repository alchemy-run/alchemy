import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { CallbackError } from "../Callback.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { dispatchCallbacks } from "../Workers/CallbackDispatcher.ts";
import {
  makeCallbackFactory,
  makeCallbackRegistry,
  openCallbackRegistry,
  type CallbackJob,
  type CallbackStore,
} from "../Workers/CallbackRegistry.ts";
import { NativeContext, type RivetActorContext } from "./DurableObjectState.ts";

/** The recurring recovery action is independent of one-shot scheduled delivery. @internal */
export const CALLBACK_ACTION = "__alchemyCallbacks";
const watchdog = "__alchemy_callback_recovery";
const keyOf = (callback: string, id: string) => JSON.stringify([callback, id]);

/**
 * Arm recurring recovery before persisting jobs, then optimize the next wake.
 * Remove jobs durably before disarming recovery. SQL leases do not participate.
 * @internal
 */
export const makeRivetCallbackStore = (): CallbackStore => {
  const mutex = Semaphore.makeUnsafe(1);
  const nativeCall = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new CallbackError({
          callback: CALLBACK_ACTION,
          message: "Rivet callback persistence failed",
          cause,
        }),
    });
  const save = (native: RivetActorContext) =>
    nativeCall(() => native.saveState({ immediate: true }));
  const armRecovery = (native: RivetActorContext) =>
    Effect.gen(function* () {
      const existing = yield* nativeCall(() => native.cron.get(watchdog));
      if (existing === undefined) {
        yield* nativeCall(() =>
          native.cron.every({
            name: watchdog,
            interval: 30_000,
            action: CALLBACK_ACTION,
            maxHistory: 0,
          }),
        );
      }
    });
  const jobs = (native: RivetActorContext) => native.state.callbacks ?? {};
  const reconcile = (native: RivetActorContext) =>
    Effect.gen(function* () {
      const pending = Object.values(jobs(native));
      const previous = native.state.callbackWake;
      if (pending.length === 0) {
        native.state.callbackWake = undefined;
        yield* save(native);
        yield* nativeCall(() => native.cron.delete(watchdog));
        if (previous)
          yield* nativeCall(() => native.schedule.cancel(previous.id));
        return;
      }
      yield* armRecovery(native);
      const at = Math.min(...pending.map((job) => job.runAt));
      const id = yield* nativeCall(() =>
        native.schedule.at(at, CALLBACK_ACTION),
      );
      native.state.callbackWake = { id, at };
      yield* save(native);
      if (previous)
        yield* nativeCall(() => native.schedule.cancel(previous.id));
    });
  const locked = <A>(effect: Effect.Effect<A, CallbackError, RuntimeContext>) =>
    effect.pipe(Effect.uninterruptible, mutex.withPermit);
  return {
    put: (job) =>
      locked(
        Effect.gen(function* () {
          const native = yield* NativeContext;
          yield* armRecovery(native);
          native.state.callbacks ??= {};
          native.state.callbacks[keyOf(job.callback, job.id)] = job;
          yield* save(native);
          yield* reconcile(native);
        }),
      ),
    remove: (callback, id) =>
      locked(
        Effect.gen(function* () {
          const native = yield* NativeContext;
          delete jobs(native)[keyOf(callback, id)];
          yield* save(native);
          yield* reconcile(native);
        }),
      ),
    prepare: () =>
      locked(
        Effect.gen(function* () {
          const native = yield* NativeContext;
          if (Object.keys(jobs(native)).length > 0) return true;
          yield* reconcile(native);
          return false;
        }),
      ),
    due: (now, limit) =>
      NativeContext.pipe(
        Effect.map((native) =>
          Object.values(jobs(native))
            .filter((job) => job.runAt <= now)
            .sort((a, b) => a.runAt - b.runAt)
            .slice(0, limit)
            .map((job) => ({ ...job })),
        ),
      ),
    claim: (job, retryAt) =>
      locked(
        Effect.gen(function* () {
          const native = yield* NativeContext;
          const key = keyOf(job.callback, job.id);
          const current = jobs(native)[key];
          if (current?.version !== job.version || current.runAt !== job.runAt)
            return false;
          yield* armRecovery(native);
          native.state.callbacks![key] = { ...job, runAt: retryAt };
          yield* save(native);
          yield* reconcile(native);
          return true;
        }),
      ),
    acknowledge: (job: CallbackJob) =>
      locked(
        Effect.gen(function* () {
          const native = yield* NativeContext;
          const key = keyOf(job.callback, job.id);
          if (jobs(native)[key]?.version !== job.version) return;
          delete jobs(native)[key];
          yield* save(native);
        }),
      ),
    sync: () => NativeContext.pipe(Effect.flatMap(save)),
    reconcile: () => locked(NativeContext.pipe(Effect.flatMap(reconcile))),
  };
};

/** One registration window and dispatcher per native activation. @internal */
export const makeRivetCallbacks = () => {
  const store = makeRivetCallbackStore();
  const registry = makeCallbackRegistry(store, Context.omit(NativeContext));
  return {
    factory: makeCallbackFactory(registry),
    initialize: () => openCallbackRegistry(registry),
    dispatch: () => dispatchCallbacks(registry),
    reconcile: store.reconcile,
  };
};
