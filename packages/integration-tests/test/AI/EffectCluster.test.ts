import * as Docker from "@alchemy.run/docker";
import * as Cluster from "@alchemy.run/effect-cluster";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ensureDockerSwarm, publishedUrl } from "../Docker/Runtime.ts";
import HostedClusterFront from "./hosted/cluster/front.ts";
import { hosted, waitForReady } from "./hosted/conformance.ts";

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Cluster.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const stack = Core.scratchStack(testOptions, "ClusterHosted", import.meta.url);

// The front's port is one Swarm picks, read from the deploy.
let url = "";
const frontUrl = Effect.sync(() => url);

// A process and the model it works with, both on Effect Cluster entities on
// two local Docker runners coordinating through Postgres, called from a
// Docker service through the gateway.
describe.skipIf(!!process.env.FAST)(
  "AI processes on Effect Cluster",
  { tags: ["provider:cluster", "provider:cluster:ai", "provider:docker", "local"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        if (!process.env.NO_DESTROY) yield* stack.destroy();
        const { front, ports } = yield* stack.deploy(
          Effect.gen(function* () {
            const front = yield* HostedClusterFront;
            return { front: front.name, ports: front.ports };
          }),
        );
        expect(front).toBeTruthy();
        url = publishedUrl(ports);
        yield* waitForReady(url);
      }),
      { timeout: 600_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(stack.destroy(), { timeout: 300_000 });

    hosted({ test, url: frontUrl });
  },
);
