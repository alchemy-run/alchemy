import type * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";
import { Greet, Recorder } from "./workflows.ts";

export const greetLive = <R>(main: string, pool: Cluster.PoolLayer<R>) =>
  Greet.make(
    { main },
    Effect.gen(function* () {
      const record = yield* Recorder;
      return Greet.of(
        Effect.fn(function* ({ id, name }) {
          const greeting = yield* Activity.make({
            name: "greet",
            success: Schema.String,
            execute: record(id, "greet").pipe(Effect.as(`hello ${name}`)),
          });
          yield* Activity.make({ name: "log", execute: record(id, "log") });
          return greeting;
        }),
      );
    }).pipe(Effect.provide(pool)),
  );
