/** Every second, the runner that owns the singleton records its hostname. */
import type * as Cluster from "@alchemy.run/cluster";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Journal } from "../workflows/journal.ts";
import { Heartbeat } from "./heartbeat.ts";

export const heartbeatLive = <R>(main: string, runners: Cluster.RunnersLayer<R>) =>
  Heartbeat.make(
    { main },
    Effect.gen(function* () {
      const journals = yield* Journal;
      return Effect.gen(function* () {
        // Read on the runner, where the fiber runs.
        const host = yield* Config.String("HOSTNAME");
        const journal = yield* journals.getByName("heartbeat");
        yield* journal.Append({ entry: host }).pipe(Effect.repeat(Schedule.spaced("1 second")));
      }).pipe(Effect.orDie);
    }).pipe(Effect.provide(runners)),
  );
