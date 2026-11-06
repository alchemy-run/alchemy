import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cluster from "@alchemy.run/effect-cluster";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformanceTests, waitForReady } from "./conformance.ts";
import Front from "./fixtures/cloudflare/front.ts";
import { Lives } from "./fixtures/cloudflare/index.ts";
import { scheduledConformanceTests } from "./scheduled-conformance.ts";
import { workflowConformanceTests } from "./workflow-conformance.ts";

const testOptions = {
  providers: Layer.mergeAll(Cloudflare.providers(), Cluster.providers()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ClusterCloudflare", import.meta.url);

let baseUrl = "";

// The Effect Cluster conformance cases, against entities, workflows,
// singletons and crons on Durable Objects, called from another Worker
// through the gateway.
describe.skipIf(!!process.env.FAST)(
  "Effect Cluster on Cloudflare (Durable Objects)",
  { tags: ["provider:cluster", "provider:cloudflare", "live"] },
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
      { timeout: 600_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 300_000 });

    conformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live", external: false });
    workflowConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
    scheduledConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
  },
);
