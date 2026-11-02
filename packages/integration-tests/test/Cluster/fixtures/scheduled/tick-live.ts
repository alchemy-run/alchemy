/** Each run records the time it was scheduled for. */
import { ClusterCron } from "effect/cluster";
import * as Effect from "effect/Effect";
import { Default } from "../cluster.ts";
import { Journal } from "../workflows/journal.ts";
import { Tick } from "./tick.ts";

export default Tick.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const journals = yield* Journal;
    return Effect.gen(function* () {
      const scheduled = yield* ClusterCron.CurrentScheduledTime;
      const journal = yield* journals.getByName("ticks");
      yield* journal.Append({ entry: String(scheduled.epochMilliseconds) });
    }).pipe(Effect.orDie);
  }).pipe(Effect.provide(Default)),
);
