/**
 * An instance whose `onSleep` and `onDestroy` count themselves on a
 * counter named after it, so a caller sees each hook ran without waking
 * the instance. `QuickLifecycle` is the same instance with its own sleep
 * settings.
 */
import * as Rivet from "@alchemy.run/rivet";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Default } from "./cluster.ts";
import Counter from "./counter.ts";

const lifecycle = Effect.gen(function* () {
  const counters = yield* Counter;
  return Effect.gen(function* () {
    const state = yield* Rivet.DurableObjectState;
    const record = (hook: string) =>
      Effect.asVoid(counters.getByName(`${hook}-${state.id.name}`).increment());
    return {
      put: (value: number) => state.storage.put("value", value),
      get: () => Effect.map(state.storage.get<number>("value"), (value) => value ?? null),
      sleepNow: () => state.sleep(),
      // Writes after `ms`: past the sleep grace period, its storage is closed.
      writeLate: (ms: number) => Effect.andThen(Effect.sleep(ms), state.storage.put("late", true)),
      // Writes every 100ms until storage fails, then reports the failure as
      // data, as a Domain object reports a defect.
      writeUntilStopped: () =>
        Effect.gen(function* () {
          for (let i = 0; i < 300; i++) {
            const exit = yield* Effect.exit(state.storage.put("busy", i));
            if (Exit.isFailure(exit)) return { failed: Cause.pretty(exit.cause) };
            yield* Effect.sleep("100 millis");
          }
          return { failed: null };
        }),
      destroyNow: () => state.destroy(),
      onSleep: () => record("slept"),
      onDestroy: () => record("destroyed"),
    };
  });
}).pipe(Effect.provide(Default));

export default class Lifecycle extends Rivet.DurableObject<Lifecycle>()(
  "Lifecycle",
  { main: import.meta.url },
  lifecycle,
) {}

/** The same instance, set to sleep 2 seconds after its last call, with 3 seconds to wind down. */
export class QuickLifecycle extends Rivet.DurableObject<QuickLifecycle>()(
  "QuickLifecycle",
  {
    main: import.meta.url,
    handler: "QuickLifecycle",
    sleepTimeout: "2 seconds",
    sleepGracePeriod: "3 seconds",
  },
  lifecycle,
) {}
