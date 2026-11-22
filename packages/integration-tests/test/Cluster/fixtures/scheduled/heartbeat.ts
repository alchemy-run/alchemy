/**
 * Every second, the runner that owns the singleton records its hostname.
 * Each host declares it inline, in its own module, with this implementation.
 */
import { hostname } from "node:os";
import type * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Journal } from "../workflows/journal.ts";

export const heartbeat = <R>(pool: Cluster.PoolLayer<R>) =>
  Effect.gen(function* () {
    const journals = yield* Journal;
    return Effect.gen(function* () {
      // The runner the fiber runs on. Not every host sets HOSTNAME (Fly
      // Machines don't), so ask the OS.
      const host = yield* Effect.sync(() => hostname());
      const journal = yield* journals.getByName("heartbeat");
      yield* journal.Append({ entry: host }).pipe(Effect.repeat(Schedule.spaced("1 second")));
    }).pipe(Effect.orDie);
  }).pipe(Effect.provide(pool));
