import { fileURLToPath } from "node:url";
import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import * as RivetDocker from "@alchemy.run/rivet/Docker";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { createClient } from "rivetkit/client";
import type { registry } from "./fixtures/external/async-actors.ts";

const CONTROL_PLANE_PORT = 16460;

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RivetExternal", import.meta.url);

const Cluster = RivetDocker.SwarmControlPlane("RivetExternal", { port: CONTROL_PLANE_PORT });
const AsyncPool = RivetDocker.SwarmPool("AsyncPool").pipe(Layer.provide(Cluster));
const EffectPool = RivetDocker.SwarmPool("EffectPool").pipe(Layer.provide(Cluster));
const RustPool = RivetDocker.SwarmPool("RustPool").pipe(Layer.provide(Cluster));

const fixture = (file: string) =>
  fileURLToPath(new URL(`./fixtures/external/${file}`, import.meta.url));

/** The node hasn't connected to its pool yet. */
class NodeNotReady extends Data.TaggedError("NodeNotReady")<{ readonly cause: unknown }> {}

/** Retry a call while the pool's node starts and connects. */
const call = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (cause) => new NodeNotReady({ cause }) }).pipe(
    Effect.timeout("20 seconds"),
    Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 30 }),
  );

let deployed: {
  token: Redacted.Redacted<string>;
  namespace: string;
  asyncPool: string;
  effectPool: string;
  rustPool: string;
};

const clientFor = (poolName: string) =>
  createClient<typeof registry>({
    endpoint: `http://localhost:${CONTROL_PLANE_PORT}`,
    token: Redacted.value(deployed.token),
    namespace: deployed.namespace,
    poolName,
  });

// RivetKit's own Actors, in its async, Effect and Rust forms, deployed as
// external Durable Objects: Alchemy bundles each TypeScript program, compiles
// the Rust crate into its node image, and runs each on a pool.
describe.skipIf(!!process.env.FAST)(
  "Rivet external Durable Objects",
  { tags: ["provider:rivet", "provider:docker", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const asyncActors = yield* Rivet.DurableObject("AsyncActors", {
              main: fixture("async-actors.ts"),
            }).pipe(Effect.provide(AsyncPool));
            const effectActors = yield* Rivet.DurableObject("EffectActors", {
              main: fixture("effect/main.ts"),
            }).pipe(Effect.provide(EffectPool));
            // A member of a Cargo workspace, built with a feature.
            const rustActors = yield* Rivet.DurableObject("RustActors", {
              crate: fixture("rust/counter"),
              build: { features: ["double"] },
            }).pipe(Effect.provide(RustPool));
            return {
              token: asyncActors.token,
              namespace: asyncActors.namespace,
              asyncPool: asyncActors.pool,
              effectPool: effectActors.pool,
              rustPool: rustActors.pool,
            };
          }),
        );
        deployed = out as typeof deployed;
      }),
      { timeout: 900_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 600_000 });

    test(
      "an async RivetKit Actor runs as it is",
      Effect.gen(function* () {
        expect(deployed.asyncPool).toBeTruthy();
        const counter = clientFor(deployed.asyncPool).counter.getOrCreate(["external-async"]);
        const first = yield* call(() => counter.increment(3));
        const second = yield* call(() => counter.increment(4));
        expect(second - first).toBe(4);
      }),
      { timeout: 300_000 },
    );

    test(
      "a @rivetkit/effect Actor runs as it is",
      Effect.gen(function* () {
        expect(deployed.effectPool).toBeTruthy();
        // The Effect form's actions take their payload as one argument.
        const counter = (clientFor(deployed.effectPool) as any).Counter.getOrCreate([
          "external-effect",
        ]);
        const before = yield* call((): Promise<number> => counter.Read());
        const after = yield* call((): Promise<number> => counter.Add({ amount: 5 }));
        expect(after - before).toBe(5);
      }),
      { timeout: 300_000 },
    );

    test(
      "a Rust Actor runs as it is",
      Effect.gen(function* () {
        expect(deployed.rustPool).toBeTruthy();
        // RivetKit's client calls a Rust Actor by name, untyped.
        const counter = clientFor(deployed.rustPool).counter.getOrCreate(["external-rust"]);
        const first = yield* call(() => counter.increment(3));
        const second = yield* call(() => counter.increment(4));
        // Built with the `double` feature: each increment counts twice.
        expect(second - first).toBe(8);
      }),
      { timeout: 300_000 },
    );
  },
);
