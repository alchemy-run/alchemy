/** Every second, the runner that owns the singleton records its hostname. */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Default } from "../cluster.ts";
import { Journal } from "../workflows/journal.ts";
import { Heartbeat } from "./heartbeat.ts";

export default Heartbeat.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const journals = yield* Journal;
    return Effect.gen(function* () {
      // Read on the runner, where the fiber runs.
      const host = yield* Config.String("HOSTNAME");
      const journal = yield* journals.getByName("heartbeat");
      yield* journal.Append({ entry: host }).pipe(Effect.repeat(Schedule.spaced("1 second")));
    }).pipe(Effect.orDie);
  }).pipe(Effect.provide(Default)),
);
