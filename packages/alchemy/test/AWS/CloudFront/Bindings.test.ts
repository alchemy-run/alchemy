import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import CloudFrontTestFunctionLive, {
  CloudFrontTestFunction,
} from "./handler.ts";

// The fixture deploys a CloudFront Distribution, which takes 3-10 minutes to
// reach `Deployed` — gate the live run per the catalog's slow-test guidance.
const runLive =
  process.env.AWS_TEST_SLOW === "1" ||
  process.env.ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS === "true";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CloudFrontBindings");

let baseUrl: string;

// Resolve the fixture's distribution out-of-band by its deterministic
// comment (runtime Output resolution inside the Lambda is not available for
// resources declared in the fixture, so the test looks the id up itself).
// Runs inside the test body — `beforeAll` has no distilled credentials
// context. `listDistributions` is eventually consistent for a
// freshly-created distribution, so retry the lookup for up to ~60s.
const findFixtureDistributionId = Effect.gen(function* () {
  const response = yield* cloudfront.listDistributions({});
  const match = (response.DistributionList?.Items ?? []).find(
    // Comment is a sensitive field — distilled decodes it as Redacted.
    (item) =>
      (typeof item.Comment === "string"
        ? item.Comment
        : Redacted.value(item.Comment)) === "alchemy-cf-bindings-fixture",
  );
  if (!match) {
    return yield* Effect.fail(
      new Error("fixture distribution not found by comment"),
    );
  }
  return match.Id;
}).pipe(
  Effect.retry({
    while: (e) => e instanceof Error,
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(30)]),
  }),
);

describe("CloudFront Bindings", () => {
  beforeAll(
    runLive
      ? Effect.gen(function* () {
          yield* Effect.logInfo("CloudFront bindings: destroying previous");
          yield* sharedStack.destroy();

          yield* Effect.logInfo(
            "CloudFront bindings: deploying fixture (distribution deploy is slow)",
          );
          const { functionUrl } = yield* sharedStack.deploy(
            Effect.gen(function* () {
              return yield* CloudFrontTestFunction;
            }).pipe(Effect.provide(CloudFrontTestFunctionLive)),
          );

          expect(functionUrl).toBeTruthy();
          baseUrl = functionUrl!.replace(/\/+$/, "");

          // Fresh function URLs take a few seconds to start serving.
          yield* HttpClient.get(`${baseUrl}/health`).pipe(
            Effect.flatMap((response) =>
              response.status === 200
                ? Effect.void
                : Effect.fail(
                    new Error(`Function not ready: ${response.status}`),
                  ),
            ),
            Effect.retry({
              while: (e) => e instanceof Error,
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(60),
              ]),
            }),
          );
        })
      : Effect.void,
    { timeout: 900_000 },
  );
  afterAll(runLive ? sharedStack.destroy() : Effect.void, {
    timeout: 900_000,
  });

  describe("CreateInvalidation", () => {
    test.provider.skipIf(!runLive)(
      "creates an invalidation for the bound distribution at runtime",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* HttpClient.execute(
            HttpClientRequest.post(`${baseUrl}/invalidate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                callerReference: "alchemy-test-invalidation-1",
                paths: ["/index.html"],
              }),
            ),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as {
            invalidationId: string;
            status: string;
          };
          expect(body.invalidationId).toBeTruthy();
          expect(["InProgress", "Completed"]).toContain(body.status);

          // Out-of-band: the invalidation exists on the distribution.
          const distributionId = yield* findFixtureDistributionId;
          const observed = yield* cloudfront.getInvalidation({
            DistributionId: distributionId,
            Id: body.invalidationId,
          });
          expect(observed.Invalidation?.Id).toBe(body.invalidationId);
        }),
      { timeout: 120_000 },
    );
  });
});
