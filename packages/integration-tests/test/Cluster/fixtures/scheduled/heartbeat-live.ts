/** Every second, the runner that owns the singleton records its hostname. */
import { hostname } from "node:os";
import type * as Cluster from "@alchemy.run/effect-cluster";
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
        // The runner the fiber runs on. Not every host sets HOSTNAME (Fly
        // Machines don't), so ask the OS.
        const host = yield* Effect.sync(() => hostname());
        const journal = yield* journals.getByName("heartbeat");
        yield* journal.Append({ entry: host }).pipe(Effect.repeat(Schedule.spaced("1 second")));
      }).pipe(Effect.orDie);
    }).pipe(Effect.provide(runners)),
  );
