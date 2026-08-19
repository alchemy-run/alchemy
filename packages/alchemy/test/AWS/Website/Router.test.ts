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
// ~5-15 min), so the full Router lifecycle exceeds any sane test budget.
// Run with ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS=true (same gate as the
// AWS.CloudFront suites).
const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS === "true";

describe.skipIf(!runLive)("AWS.Website.Router", () => {
  test.provider(
    "create router with static-site attached via KV routing",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const router = yield* AWS.Website.Router("Router", {
              invalidation: {
                paths: "all",
                wait: true,
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
    // The budget must fit THREE full CloudFront propagation waits (~5-12 min
    // each), not two: when a previous run's teardown was abandoned (the
    // runner gives interrupted finalizers only a 10s grace), the next run's
    // initial stack.destroy() has to wait out the leftover distribution's
    // disable before deleting it, then still do its own create-deploy wait
    // and disable->wait->delete teardown. If this times out with the destroy
    // apparently stalled between waves, suspect an unbounded retry backoff
    // first: the 2026-08-13 "hang" was the KvEntries/KvRoutesUpdate etag-race
    // retry sleeping on an uncapped exponential (see kvsEtagRetrySchedule in
    // src/AWS/CloudFront/common.ts), not CloudFront.
    { timeout: 2_400_000 },
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
