import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";

const { test } = Test.make({ providers: AWS.providers() });

// Anchor the fixture to the repo root regardless of the runner's cwd.
const fixtureDir = fileURLToPath(
  new URL("../../../../../examples/aws-static-site/site", import.meta.url),
);

// Gated: CloudFront Distribution create blocks on Status === "Deployed"
// (~5-15 min) and destroy requires disable -> wait -> delete (another
// ~5-15 min). Runs by default; skipped under --fast (same gate as the
// AWS.CloudFront suites).
const runLive = !process.env.FAST;

describe.skipIf(!runLive)("AWS.Website.Router", () => {
  // Regression context: this case used to eat its whole 40-minute budget.
  // The sink was the destroy's concurrent KvEntries purge + KvRoutesUpdate
  // removal racing on the same KeyValueStore etag — the loser retried with
  // a STALE etag (never convergent) on an uncapped exponential schedule
  // (attempt 14 sleeps ~14 minutes). Fixed in KvEntries/KvRoutesUpdate:
  // etag re-fetch on Pre-Condition failure + the shared 2s-capped retry
  // schedule. Full lifecycle now measures ~8.5 minutes.
  test.provider(
    "create router with static-site attached via KV routing",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const router = yield* AWS.Website.Router("Router", {
              // No `wait`: the test already polls the URL through edge
              // propagation, and waiting on the invalidation adds 5-10
              // minutes per attempt under full-battery CloudFront
              // contention for no additional signal.
              invalidation: {
                paths: "all",
              },
            });

            const site = yield* AWS.Website.StaticSite("DocsSite", {
              path: fixtureDir,
              forceDestroy: true,
              domain: {
                router,
              },
            });

            return {
              site,
              router,
            };
          }),
        );

        expect(deployed.router.distribution.distributionId).toBeDefined();
        expect(deployed.router.kvStoreArn).toBeDefined();

        // urls contract (cloudfront-default arm): a router without a
        // domain serves only at its CloudFront default domain, and `url`
        // is always `urls[0]`.
        expect(deployed.router.urls).toEqual([
          `https://${deployed.router.distribution.domainName}`,
        ]);
        expect(deployed.router.url).toBe(deployed.router.urls[0]);
        // A path-only attached site inherits the router's primary URL.
        expect(deployed.site.urls).toEqual([deployed.router.url]);
        expect(deployed.site.url).toBe(deployed.site.urls[0]);

        const config = yield* cloudfront.getDistributionConfig({
          Id: deployed.router.distribution.distributionId,
        });
        expect(
          config.DistributionConfig?.DefaultCacheBehavior?.FunctionAssociations
            ?.Quantity,
        ).toBeGreaterThanOrEqual(1);

        yield* stack.destroy();
        yield* assertDistributionDeleted(
          deployed.router.distribution.distributionId,
        );
      }),
    // Create waits for Status === "Deployed" (~5 min) and destroy is
    // disable -> wait -> delete (~5-15 min more): 600s was measured too
    // small — the run died mid-destroy with green assertions.
    // CloudFront full lifecycle (create + KV-routed assertions + disable +
    // delete) measures ~6m with bounded polls; generous headroom for
    // propagation variance. The initial stack.destroy() may also inherit a
    // PREVIOUS timed-out attempt's abandoned mid-delete distribution
    // (disable→delete is 5-15m on its own), so the budget covers one
    // generation of inherited teardown debt — without it, a single timeout
    // cascades into every later run. `retry: 0`: retrying a timed-out
    // CloudFront lifecycle only compounds 20-minute attempts (and each
    // abandoned teardown seeds the next attempt's debt). If this times
    // out on a CLEAN account, suspect a hung poll first (see the
    // Effect.timeout guards in Distribution.ts), not CloudFront.
    { timeout: 2_400_000, retry: 0 },
  );
});

const assertDistributionDeleted = (distributionId: string) =>
  cloudfront.getDistribution({ Id: distributionId }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("DistributionStillExists"))),
    Effect.catchTag("NoSuchDistribution", () => Effect.void),
    Effect.retry({
      while: (error) =>
        error instanceof Error && error.message === "DistributionStillExists",
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(60),
      ]),
    }),
  );
