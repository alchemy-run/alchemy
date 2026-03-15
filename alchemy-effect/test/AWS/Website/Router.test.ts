import * as AWS from "@/AWS";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

describe("AWS.Website.Router", () => {
  test(
    "create router for a static-site route with edge functions and invalidation",
    { timeout: 600_000 },
    Effect.gen(function* () {
      yield* destroy();

      const deployed = yield* test.deploy(
        Effect.gen(function* () {
          const site = yield* AWS.Website.StaticSite("DocsSite", {
            path: "examples/aws-static-site/site",
            cdn: false,
            forceDestroy: true,
          });

          const router = yield* AWS.Website.Router("Router", {
            routes: {
              "/*": {
                ...site.routeTarget,
                edge: {
                  viewerRequest: {
                    injection:
                      'request.headers["x-router"] = { value: "docs" };',
                  },
                  viewerResponse: {
                    injection:
                      'response.headers["x-router-response"] = { value: "docs" };',
                  },
                },
              },
            },
            invalidation: {
              paths: "versioned",
              wait: true,
            },
          });

          return {
            site,
            router,
          };
        }),
      );

      expect(deployed.router.distribution.distributionId).toBeDefined();
      expect(deployed.router.invalidation?.invalidationId).toBeDefined();

      const config = yield* cloudfront.getDistributionConfig({
        Id: deployed.router.distribution.distributionId,
      });
      expect(
        config.DistributionConfig?.DefaultCacheBehavior?.FunctionAssociations
          ?.Quantity,
      ).toEqual(2);

      yield* destroy();
      yield* assertDistributionDeleted(
        deployed.router.distribution.distributionId,
      );
    }).pipe(Effect.provide(AWS.providers())),
  );
});

const assertDistributionDeleted = (distributionId: string) =>
  cloudfront.getDistribution({ Id: distributionId }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("DistributionStillExists"))),
    Effect.catchTag("NoSuchDistribution", () => Effect.void),
    Effect.retry({
      while: (error) =>
        error instanceof Error && error.message === "DistributionStillExists",
      schedule: Schedule.fixed("10 seconds").pipe(
        Schedule.both(Schedule.recurs(60)),
      ),
    }),
  );
