/**
 * Each run records the time it was scheduled for. Each host declares the
 * cron inline, in its own module, with this schedule and implementation.
 */
import type * as Cluster from "@alchemy.run/effect-cluster";
import { ClusterCron } from "effect/cluster";
import * as Effect from "effect/Effect";
import { Journal } from "../workflows/journal.ts";

export const TICK_SCHEDULE = "*/2 * * * * *";

export const tick = <R>(pool: Cluster.PoolLayer<R>) =>
  Effect.gen(function* () {
    const journals = yield* Journal;
    return Effect.gen(function* () {
      const scheduled = yield* ClusterCron.CurrentScheduledTime;
      const journal = yield* journals.getByName("ticks");
      yield* journal.Append({ entry: String(scheduled.epochMilliseconds) });
    }).pipe(Effect.orDie);
  }).pipe(Effect.provide(pool));
