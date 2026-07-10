import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";
import FraudDetectorTestFunctionLive, {
  FRAUD_EMAIL,
  FraudDetectorTestFunction,
  REVIEW_OUTCOME,
} from "./fixtures/handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

// The standing test account has no frauddetector:* IAM grant, so every live
// call surfaces AccessDeniedException. The full rule-based E2E is gated behind
// AWS_TEST_FRAUDDETECTOR=1 and runs unchanged in an entitled account; an
// ungated typed-error probe proves credentials reach the service and the SDK
// decodes a typed error either way.
const RUN_LIVE = !!process.env.AWS_TEST_FRAUDDETECTOR;

// Ungated typed-error probe: proves credentials reach Fraud Detector and the
// SDK decodes a typed error. In an entitled account the missing detector
// surfaces as ResourceNotFoundException; an ungranted account surfaces
// AccessDeniedException. Either way the boundary is a typed tag.
test.provider("getDetectors on a nonexistent id fails with a typed error", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      frauddetector.getDetectors({ detectorId: "does_not_exist_detector" }),
    );
    expect(
      ["ResourceNotFoundException", "AccessDeniedException"].includes(
        error._tag,
      ),
    ).toBe(true);
  }),
);

const sharedStack = Core.scratchStack(testOptions, "FraudDetectorPrediction");

let baseUrl: string;

describe("FraudDetector GetEventPrediction (E2E)", () => {
  beforeAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      yield* Effect.logInfo("FraudDetector E2E setup: destroying previous run");
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "FraudDetector E2E setup: deploying entity type + variables + outcome + event type + detector + active version + Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* FraudDetectorTestFunction;
        }).pipe(Effect.provide(FraudDetectorTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds to serve 200s.
      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.fixed("2 seconds").pipe(
            Schedule.both(Schedule.recurs(60)),
          ),
        }),
      );
    }),
    { timeout: 300_000 },
  );
  afterAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      yield* sharedStack.destroy();
    }),
    { timeout: 300_000 },
  );

  test.provider.skipIf(!RUN_LIVE)(
    "a fraud email is scored and returns the review outcome",
    () =>
      Effect.gen(function* () {
        // The detector version may take a moment to become ACTIVE after
        // deploy; retry through transient 5xx while it settles.
        const response = yield* HttpClient.execute(
          HttpClientRequest.post(`${baseUrl}/predict`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ email: FRAUD_EMAIL }),
          ),
        ).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? Effect.succeed(res)
              : Effect.fail(new Error(`predict failed: ${res.status}`)),
          ),
          Effect.retry({
            schedule: Schedule.exponential("2 seconds").pipe(
              Schedule.both(Schedule.recurs(8)),
            ),
          }),
        );
        const body = (yield* response.json) as { outcomes: string[] };
        expect(body.outcomes).toContain(REVIEW_OUTCOME);
      }),
    { timeout: 180_000 },
  );

  test.provider.skipIf(!RUN_LIVE)(
    "a benign email matches no rule and returns no outcome",
    () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.execute(
          HttpClientRequest.post(`${baseUrl}/predict`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ email: "legit@example.com" }),
          ),
        ).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? Effect.succeed(res)
              : Effect.fail(new Error(`predict failed: ${res.status}`)),
          ),
          Effect.retry({
            schedule: Schedule.exponential("2 seconds").pipe(
              Schedule.both(Schedule.recurs(8)),
            ),
          }),
        );
        const body = (yield* response.json) as { outcomes: string[] };
        expect(body.outcomes).not.toContain(REVIEW_OUTCOME);
      }),
    { timeout: 180_000 },
  );
});
