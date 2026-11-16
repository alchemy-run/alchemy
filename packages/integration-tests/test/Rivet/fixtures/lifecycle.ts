/**
 * An instance whose `onSleep` and `onDestroy` count themselves on a
 * counter named after it, so a caller sees each hook ran without waking
 * the instance.
 */
import * as Rivet from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";
import { Default } from "./cluster.ts";
import Counter from "./counter.ts";

export default class Lifecycle extends Rivet.DurableObject<Lifecycle>()(
  "Lifecycle",
  { main: import.meta.url },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return Effect.gen(function* () {
      const state = yield* Rivet.DurableObjectState;
      const record = (hook: string) =>
        Effect.asVoid(counters.getByName(`${hook}-${state.id.name}`).increment());
      return {
        put: (value: number) => state.storage.put("value", value),
        get: () => Effect.map(state.storage.get<number>("value"), (value) => value ?? null),
        sleepNow: () => state.sleep(),
        destroyNow: () => state.destroy(),
        onSleep: () => record("slept"),
        onDestroy: () => record("destroyed"),
      };
    });
  }).pipe(Effect.provide(Default)),
) {}
