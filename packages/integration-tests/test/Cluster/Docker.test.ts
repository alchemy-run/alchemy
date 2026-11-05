import * as Docker from "@alchemy.run/docker";
import * as Cluster from "@alchemy.run/effect-cluster";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ensureDockerSwarm } from "../Docker/Runtime.ts";
import { conformanceTests, get, waitForReady } from "./conformance.ts";
import { FRONT_PORT } from "./fixtures/docker/cluster.ts";
import Front from "./fixtures/docker/front.ts";
import { Lives } from "./fixtures/docker/index.ts";
import { scheduledConformanceTests } from "./scheduled-conformance.ts";
import { workflowConformanceTests } from "./workflow-conformance.ts";

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Cluster.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ClusterDocker", import.meta.url);

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

    test(
      "a workflow declared inline runs",
      Effect.gen(function* () {
        expect((yield* get(`${baseUrl}/shout/hey`)).value).toBe("HEY");
      }),
      { timeout: 120_000 },
    );
  },
);
