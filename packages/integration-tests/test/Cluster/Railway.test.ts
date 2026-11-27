import * as Cluster from "@alchemy.run/effect-cluster";
import * as Railway from "@alchemy.run/railway";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { railwayApi } from "../Railway/limit.ts";
import { conformanceTests, waitForReady } from "./conformance.ts";
import Front from "./fixtures/railway/front.ts";
import { Lives } from "./fixtures/railway/index.ts";
import { scheduledConformanceTests } from "./scheduled-conformance.ts";
import { workflowConformanceTests } from "./workflow-conformance.ts";

const testOptions = { providers: Layer.mergeAll(Railway.providers(), Cluster.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ClusterRailway", import.meta.url);

let baseUrl = "";

// The Effect Cluster conformance cases, against Railway Postgres and a
// runner Service per pool, called from a public Railway Service through the
// gateways on the project's private network.
describe.skipIf(!!process.env.FAST)(
  "Effect Cluster on Railway (Railway Postgres, Railway Service runners)",
  { tags: ["provider:cluster", "provider:railway", "live"] },
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
      // Only deploy and destroy drive Railway's API. The cases call the front.
      { timeout: 1_800_000, exclusive: railwayApi },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
      timeout: 1_200_000,
      exclusive: railwayApi,
    });

    conformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
    workflowConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
    scheduledConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
  },
);
