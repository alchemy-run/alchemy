import * as Cluster from "@alchemy.run/cluster";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Activity, DurableClock } from "effect/workflow";
import { Default } from "../cluster.ts";
import { Nap, Recorder } from "./workflows.ts";

export default Cluster.Workflow(
  Nap,
  { main: import.meta.url },
  Effect.gen(function* () {
    const record = yield* Recorder;
    return Effect.fn(function* ({ id, seconds }) {
      yield* Activity.make({ name: "before", execute: record(id, "before") });
      yield* DurableClock.sleep({
        name: "nap",
        duration: `${seconds} seconds`,
        inMemoryThreshold: 0,
      });
      yield* Activity.make({ name: "after", execute: record(id, "after") });
      return "rested";
    });
  }),
).pipe(Layer.provide(Default));
