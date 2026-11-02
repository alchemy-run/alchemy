import * as Effect from "effect/Effect";
import { Activity, DurableClock } from "effect/workflow";
import { Default } from "../cluster.ts";
import { Nap, Recorder } from "./workflows.ts";

export default Nap.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const record = yield* Recorder;
    return Nap.of(
      Effect.fn(function* ({ id, seconds }) {
        yield* Activity.make({ name: "before", execute: record(id, "before") });
        yield* DurableClock.sleep({
          name: "nap",
          duration: `${seconds} seconds`,
          inMemoryThreshold: 0,
        });
        yield* Activity.make({ name: "after", execute: record(id, "after") });
        return "rested";
      }),
    );
  }).pipe(Effect.provide(Default)),
);
