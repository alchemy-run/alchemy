/** A cron that logs each scheduled time, which a test reads from the journal. */
import * as Cluster from "@alchemy.run/effect-cluster";
import { ClusterCron } from "effect/cluster";
import * as Effect from "effect/Effect";
import { Default } from "./cluster.ts";

export default class Tick extends Cluster.Cron<Tick>()(
  "Tick",
  { main: import.meta.url, cron: "*/2 * * * * *" },
  Effect.succeed(
    Effect.gen(function* () {
      const scheduled = yield* ClusterCron.CurrentScheduledTime;
      yield* Effect.log(`nixos-fixture tick ${scheduled.epochMilliseconds}`);
    }),
  ).pipe(Effect.provide(Default)),
) {}
