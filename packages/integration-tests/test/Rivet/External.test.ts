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

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RivetExternal", import.meta.url);

// On a free port, so the suite runs beside itself in other worktrees.
const Cluster = RivetDocker.SwarmControlPlane("RivetExternal", { port: 0 });
const AsyncPool = RivetDocker.SwarmPool("AsyncPool").pipe(Layer.provide(Cluster));
const EffectPool = RivetDocker.SwarmPool("EffectPool").pipe(Layer.provide(Cluster));
const RustPool = RivetDocker.SwarmPool("RustPool").pipe(Layer.provide(Cluster));
const ImagePool = RivetDocker.SwarmPool("ImagePool").pipe(Layer.provide(Cluster));
const DockerfilePool = RivetDocker.SwarmPool("DockerfilePool").pipe(Layer.provide(Cluster));

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

/**
 * Every external Durable Object, on a pool of its own. `step` is baked into
 * the prebuilt image as `STEP`: its counter adds `x * STEP`.
 */
const program = (step: string) =>
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
    // An image the app builds itself, with its own runtime and RivetKit,
    // run as it is.
    const appImage = yield* Docker.Image("AppImage", {
      build: {
        context: fixture("."),
        dockerfile: fixture("image.Dockerfile"),
        args: { STEP: step },
      },
    });
    const imageActors = yield* Rivet.DurableObject("ImageActors", {
      image: appImage.imageRef,
    }).pipe(Effect.provide(ImagePool));
    // The app's own Dockerfile, built by the pool.
    const dockerfileActors = yield* Rivet.DurableObject("DockerfileActors", {
      context: fixture("."),
      dockerfile: fixture("image.Dockerfile"),
    }).pipe(Effect.provide(DockerfilePool));
    const cluster = yield* Rivet.Cluster.pipe(Effect.provide(Cluster));
    return {
      endpoint: cluster.endpoint,
      token: asyncActors.token,
      namespace: asyncActors.namespace,
      asyncPool: asyncActors.pool,
      effectPool: effectActors.pool,
      rustPool: rustActors.pool,
      imagePool: imageActors.pool,
      dockerfilePool: dockerfileActors.pool,
    };
  });

let deployed: {
  endpoint: string;
  token: Redacted.Redacted<string>;
  namespace: string;
  asyncPool: string;
  effectPool: string;
  rustPool: string;
  imagePool: string;
  dockerfilePool: string;
};

const clientFor = (poolName: string) =>
  createClient<typeof registry>({
    endpoint: deployed.endpoint,
    token: Redacted.value(deployed.token),
    namespace: deployed.namespace,
    poolName,
  });

// RivetKit's own Actors, in its async, Effect and Rust forms, deployed as
// external Durable Objects: Alchemy bundles each TypeScript program, compiles
// the Rust crate into its node image, and runs each on a pool.
describe.skipIf(!!process.env.FAST)(
  "Rivet external Durable Objects",
  { tags: ["provider:rivet", "provider:docker", "live"], sequential: true },
  () => {
    beforeAll(
      Effect.gen(function* () {
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        deployed = (yield* sharedStack.deploy(program("1"))) as typeof deployed;
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

    test(
      "a prebuilt image runs as it is",
      Effect.gen(function* () {
        expect(deployed.imagePool).toBeTruthy();
        const counter = clientFor(deployed.imagePool).counter.getOrCreate(["external-image"]);
        const first = yield* call(() => counter.increment(3));
        const second = yield* call(() => counter.increment(4));
        expect(second - first).toBe(4);
      }),
      { timeout: 300_000 },
    );

    test(
      "an app's own Dockerfile runs as it is",
      Effect.gen(function* () {
        expect(deployed.dockerfilePool).toBeTruthy();
        const counter = clientFor(deployed.dockerfilePool).counter.getOrCreate([
          "external-dockerfile",
        ]);
        const first = yield* call(() => counter.increment(3));
        const second = yield* call(() => counter.increment(4));
        expect(second - first).toBe(4);
      }),
      { timeout: 300_000 },
    );

    // Runs last: it redeploys the shared stack.
    test(
      "a new image rolls the pool's nodes onto it",
      Effect.gen(function* () {
        deployed = (yield* sharedStack.deploy(program("2"))) as typeof deployed;
        const counter = clientFor(deployed.imagePool).counter.getOrCreate(["external-image-2"]);
        // The old nodes may still answer while the new ones start.
        const doubled = yield* call(() =>
          counter
            .increment(4)
            .then((before) => counter.increment(4).then((after) => after - before)),
        ).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (delta) => delta === 8,
            times: 30,
          }),
        );
        expect(doubled).toBe(8);
      }),
      { timeout: 600_000 },
    );
  },
);
