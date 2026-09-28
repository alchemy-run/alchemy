import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { CallbackError } from "../Callback.ts";
import type { CallbackRegistry } from "./CallbackRegistry.ts";

/** Persist recovery before invoking external work, then acknowledge only the claimed version. */
export const dispatchCallbacks = (
  registry: CallbackRegistry,
  hasLegacyHandler = false,
) =>
  Effect.gen(function* () {
    const { store, callbacks } = registry;
    if (!(yield* store.prepare(callbacks.size > 0, hasLegacyHandler))) return;
    const now = yield* Clock.currentTimeMillis;
    const due = yield* store.due(now, 100);
    for (const job of due) {
      const callback = callbacks.get(job.callback);
      const now = yield* Clock.currentTimeMillis;
      const claimed = yield* store.claim(
        job,
        now + (callback?.retryDelay ?? 30_000),
      );
      if (!claimed) continue;
      yield* store.sync();
      const result = yield* Effect.gen(function* () {
        if (!callback) {
          return yield* Effect.fail(
            new CallbackError({
              callback: job.callback,
              message: "No handler is registered for a pending alarm",
            }),
          );
        }
        const payload = yield* Effect.try({
          try: () => JSON.parse(job.payload),
          catch: (cause) =>
            new CallbackError({
              callback: job.callback,
              message: "Invalid persisted alarm payload",
              cause,
            }),
        });
        yield* callback.handler(payload);
      }).pipe(Effect.scoped, Effect.exit);
      if (Exit.isFailure(result)) {
        if (Cause.hasInterrupts(result.cause))
          return yield* Effect.failCause(result.cause);
        yield* Effect.logError(
          "Durable Object alarm callback failed",
          result.cause,
        );
        continue;
      }
      yield* store.acknowledge(job);
    }
    yield* store.reconcile();
  });
