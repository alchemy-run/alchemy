/** Each run records the time it was scheduled for. */
import type * as Cluster from "@alchemy.run/effect-cluster";
import { ClusterCron } from "effect/cluster";
import * as Effect from "effect/Effect";
import { Journal } from "../workflows/journal.ts";
import { Tick } from "./tick.ts";

export const tickLive = <R>(main: string, pool: Cluster.PoolLayer<R>) =>
  Tick.make(
    { main, cron: "*/2 * * * * *" },
    Effect.gen(function* () {
      const journals = yield* Journal;
      return Effect.gen(function* () {
        const scheduled = yield* ClusterCron.CurrentScheduledTime;
        const journal = yield* journals.getByName("ticks");
        yield* journal.Append({ entry: String(scheduled.epochMilliseconds) });
      }).pipe(Effect.orDie);
    }).pipe(Effect.provide(pool)),
  );
