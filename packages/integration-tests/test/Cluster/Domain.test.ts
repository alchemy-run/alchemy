import * as Docker from "@alchemy.run/docker";
import * as Cluster from "@alchemy.run/effect-cluster";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ensureDockerSwarm } from "../Docker/Runtime.ts";
import { conformance, waitForReady } from "../Domain/conformance/conformance.ts";
import { DOMAIN_FRONT_PORT } from "./fixtures/domain/cluster.ts";
import DomainFront from "./fixtures/domain/front.ts";

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Cluster.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const stack = Core.scratchStack(testOptions, "ClusterDomain", import.meta.url);

const url = `http://localhost:${DOMAIN_FRONT_PORT}`;

// The Domain conformance suite, with the model on Effect Cluster entities on
// two local Docker runners coordinating through Postgres, called from a
// Docker service through the gateway.
describe.skipIf(!!process.env.FAST)(
  "Domain on Effect Cluster",
  { tags: ["provider:cluster", "provider:cluster:domain", "provider:docker", "local"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        if (!process.env.NO_DESTROY) yield* stack.destroy();
        const outputs = yield* stack.deploy(
          Effect.gen(function* () {
            const front = yield* DomainFront;
            return { front: front.name };
          }),
        );
        expect(outputs.front).toBeTruthy();
        yield* waitForReady(url);
      }),
      { timeout: 600_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(stack.destroy(), { timeout: 300_000 });

    conformance({ test, url: Effect.succeed(url), kind: "local" });
  },
);
