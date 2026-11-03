import type * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import { Activity, DurableDeferred } from "effect/workflow";
import { Approval, Approve, Recorder } from "./workflows.ts";

export const approveLive = <R>(main: string, pool: Cluster.PoolLayer<R>) =>
  Approve.make(
    { main },
    Effect.gen(function* () {
      const record = yield* Recorder;
      return Approve.of(
        Effect.fn(function* ({ id }) {
          yield* Activity.make({ name: "requested", execute: record(id, "requested") });
          const by = yield* DurableDeferred.await(Approval);
          yield* Activity.make({ name: "approved", execute: record(id, `approved:${by}`) });
          return `approved by ${by}`;
        }),
      );
    }).pipe(Effect.provide(pool)),
  );
