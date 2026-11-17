/**
 * The Rust Durable Object every pool suite deploys: Rivet's Rust quickstart
 * Actor, a member of a Cargo workspace, built with its `double` feature.
 */
import { fileURLToPath } from "node:url";
import * as Rivet from "@alchemy.run/rivet";
import { expect } from "@alchemy.run/test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { createClient } from "rivetkit/client";
import type { registry } from "./external/async-actors.ts";

/** What a caller needs to reach the Rust Durable Object. */
export interface RustTarget {
  readonly endpoint: string;
  readonly token: Redacted.Redacted<string>;
  readonly namespace: string;
  readonly pool: string;
}

/** Declare the Rust Durable Object; provide it a pool. */
export const RustActors = (id = "RustActors") =>
  Rivet.DurableObject(id, {
    crate: fileURLToPath(new URL("./external/rust/counter", import.meta.url)),
    build: { features: ["double"] },
  });

/** The Durable Object's attributes a test calls it with. */
export const rustTarget = (actors: Rivet.DurableObject) => ({
  endpoint: actors.endpoint,
  token: actors.token,
  namespace: actors.namespace,
  pool: actors.pool,
});

/** The pool's node hasn't connected yet. */
class NodeNotReady extends Data.TaggedError("NodeNotReady")<{ readonly cause: unknown }> {}

/**
 * Call the Rust Actor through RivetKit's client, as Rivet documents it,
 * retrying while its pool's node starts, and check it counts twice per
 * increment (the `double` feature reached Cargo).
 */
export const expectRustCounter = Effect.fn(function* (target: RustTarget, key: string) {
  const counter = createClient<typeof registry>({
    endpoint: target.endpoint,
    token: Redacted.value(target.token),
    namespace: target.namespace,
    poolName: target.pool,
  }).counter.getOrCreate([key]);
  const call = (amount: number) =>
    Effect.tryPromise({
      try: () => counter.increment(amount),
      catch: (cause) => new NodeNotReady({ cause }),
    });
  // Wait for the node with a call that changes nothing: an attempt that
  // times out can still land, so the counted calls are never retried.
  yield* call(0).pipe(
    Effect.timeout("20 seconds"),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 36 }),
  );
  const first = yield* call(3);
  const second = yield* call(4);
  expect(second - first).toBe(8);
});
