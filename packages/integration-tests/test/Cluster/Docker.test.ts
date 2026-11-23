import * as Docker from "@alchemy.run/docker";
import * as Cluster from "@alchemy.run/effect-cluster";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { ensureDockerSwarm } from "../Docker/Runtime.ts";
import { conformanceTests, get, waitForReady } from "./conformance.ts";
import { FRONT_PORT as URL_FRONT_PORT, Postgres } from "./fixtures/docker-url/cluster.ts";
import UrlFront from "./fixtures/docker-url/front.ts";
import { FRONT_PORT } from "./fixtures/docker/cluster.ts";
import Front from "./fixtures/docker/front.ts";
import { Lives } from "./fixtures/docker/index.ts";
import { scheduledConformanceTests } from "./scheduled-conformance.ts";
import { workflowConformanceTests } from "./workflow-conformance.ts";

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Cluster.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ClusterDocker", import.meta.url);
const urlStack = Core.scratchStack(testOptions, "ClusterDockerUrl", import.meta.url);

const baseUrl = `http://localhost:${FRONT_PORT}`;

// The Effect Cluster conformance cases, against entities on two local Docker
// runners coordinating through Postgres, called from a Docker service through
// the gateway.
describe.skipIf(!!process.env.FAST)(
  "Effect Cluster on Docker",
  { tags: ["provider:cluster", "provider:docker", "local"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const outputs = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const front = yield* Front;
            return { front: front.name };
          }).pipe(Effect.provide(Lives)),
        );
        expect(outputs.front).toBeTruthy();
        yield* waitForReady(baseUrl);
      }),
      { timeout: 600_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 300_000 });

    conformanceTests(test as never, { baseUrl: () => baseUrl, kind: "local" });
    workflowConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "local" });
    scheduledConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "local" });

    test(
      "an entity declared inline answers its callers",
      Effect.gen(function* () {
        expect((yield* get(`${baseUrl}/echo/hi`)).value).toBe("echo hi");
      }),
      { timeout: 120_000 },
    );

    // Last: it redeploys the stack. Each deploy bundles each pool's program
    // once, however many of its resources read it, in the plan and in apply.
    test(
      "a pool redeployed again and again bundles its program once per deploy",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = path.resolve(".alchemy", "cluster");
        for (let i = 0; i < 3; i++) {
          // Every bundle writes its pool's directory anew: count the
          // directories each pool's path held during the deploy.
          const seen = new Map<string, Set<bigint>>();
          const sampler = yield* Effect.gen(function* () {
            for (const entry of yield* fs.readDirectory(root)) {
              const info = yield* fs.stat(path.join(root, entry)).pipe(Effect.option);
              if (Option.isSome(info) && Option.isSome(info.value.ino)) {
                const inodes = seen.get(entry) ?? new Set<bigint>();
                inodes.add(info.value.ino.value);
                seen.set(entry, inodes);
              }
            }
          }).pipe(Effect.repeat(Schedule.spaced("10 millis")), Effect.forkChild);
          yield* Effect.sleep("100 millis");
          const before = new Map([...seen].map(([entry, inodes]) => [entry, inodes.size]));
          yield* sharedStack.deploy(
            Effect.gen(function* () {
              const front = yield* Front;
              return { front: front.name };
            }).pipe(Effect.provide(Lives)),
          );
          yield* Fiber.interrupt(sampler);
          const bundles = [...seen].map(
            ([entry, inodes]) => inodes.size - (before.get(entry) ?? 0),
          );
          expect(bundles.length).toBeGreaterThan(0);
          for (const count of bundles) expect(count).toBeLessThanOrEqual(1);
        }
        expect((yield* get(`${baseUrl}/echo/again`)).value).toBe("echo again");
      }),
      { timeout: 600_000, exclusive: true },
    );

    test(
      "a workflow declared inline runs",
      Effect.gen(function* () {
        expect((yield* get(`${baseUrl}/shout/hey`)).value).toBe("HEY");
      }),
      { timeout: 120_000 },
    );
  },
);

// A pool given a database by URL (`Cluster.Database.fromUrl`), which is on no
// Docker network: the runners join the network Postgres is on (#3437).
describe.skipIf(!!process.env.FAST)(
  "Effect Cluster on Docker with a database by URL",
  { tags: ["provider:cluster", "provider:docker", "local"] },
  () => {
    test(
      "a pool runs entities on a database given by URL",
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        yield* urlStack.destroy();
        yield* urlStack.deploy(
          Effect.gen(function* () {
            yield* Postgres;
            const front = yield* UrlFront;
            return { front: front.name };
          }),
        );
        const response = yield* get(`http://localhost:${URL_FRONT_PORT}/echo/hi`).pipe(
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
        );
        expect(response.value).toBe("echo hi");
        yield* urlStack.destroy();
      }),
      { timeout: 600_000 },
    );
  },
);
