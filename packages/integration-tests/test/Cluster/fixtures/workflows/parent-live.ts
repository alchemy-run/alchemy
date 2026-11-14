import type * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import { Activity } from "effect/workflow";
import { Greet, Parent, Recorder } from "./workflows.ts";

export const parentLive = <R>(main: string, pool: Cluster.PoolLayer<R>) =>
  Parent.make(
    { main },
    Effect.gen(function* () {
      const record = yield* Recorder;
      return Parent.of(
        Effect.fn(function* ({ id }) {
          const greeting = yield* Greet.execute({ id: `${id}-child`, name: "child" });
          yield* Activity.make({ name: "parent", execute: record(id, `parent:${greeting}`) });
          return `parent got ${greeting}`;
        }),
      );
    }).pipe(Effect.provide(pool)),
  );
