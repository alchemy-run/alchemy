import type * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import { Activity, DurableClock } from "effect/workflow";
import { Nap, Recorder } from "./workflows.ts";

export const napLive = <R>(main: string, pool: Cluster.PoolLayer<R>) =>
  Nap.make(
    { main },
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
    }).pipe(Effect.provide(pool)),
  );
