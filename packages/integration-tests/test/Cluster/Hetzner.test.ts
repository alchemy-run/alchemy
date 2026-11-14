import * as Cluster from "@alchemy.run/effect-cluster";
import * as Hetzner from "@alchemy.run/hetzner";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformanceTests, waitForReady } from "./conformance.ts";
import Front from "./fixtures/hetzner/front.ts";
import { Lives } from "./fixtures/hetzner/index.ts";
import { scheduledConformanceTests } from "./scheduled-conformance.ts";
import { workflowConformanceTests } from "./workflow-conformance.ts";

const testOptions = { providers: Layer.mergeAll(Hetzner.providers(), Cluster.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ClusterHetzner", import.meta.url);

let baseUrl = "";

// The Effect Cluster conformance cases, against Postgres on a Hetzner Server
// and runners on Servers behind a Load Balancer, called from a Hetzner
// Service through the public gateways.
describe.skipIf(!!process.env.FAST)(
  "Effect Cluster on Hetzner (Server database, Servers behind a Load Balancer)",
  { tags: ["provider:cluster", "provider:hetzner", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const { url } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const front = yield* Front;
            return { url: front.url };
          }).pipe(Effect.provide(Lives)),
        );
        expect(url).toBeTruthy();
        baseUrl = String(url).replace(/\/+$/, "");
        yield* waitForReady(baseUrl);
      }),
      { timeout: 1_800_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 1_200_000 });

    conformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
    workflowConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
    scheduledConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
  },
);
