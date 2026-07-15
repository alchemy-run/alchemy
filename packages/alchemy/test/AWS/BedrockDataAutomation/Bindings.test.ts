import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import BdaTestFunctionLive, { BdaTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BdaBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let profileArn: string | undefined;

// The cross-region data automation profile ARN is account + geography
// scoped. Credentials are only provided inside `test.provider` contexts, so
// this is computed lazily by the first test that needs it.
const getProfileArn = Effect.gen(function* () {
  if (profileArn !== undefined) return profileArn;
  const { Account } = yield* sts.getCallerIdentity({});
  const region = yield* Effect.sync(
    () => process.env.AWS_REGION ?? "us-west-2",
  );
  const geo = region.startsWith("eu-")
    ? "eu"
    : region.startsWith("ap-")
      ? "apac"
      : "us";
  profileArn = `arn:aws:bedrock:${region}:${Account}:data-automation-profile/${geo}.data-automation-v1`;
  return profileArn;
});

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policies that the
// handler's `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine
// 4xx/assertion failure surfaces immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

describe.sequential("BedrockDataAutomation Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("BDA test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("BDA test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* BdaTestFunction;
        }).pipe(Effect.provide(BdaTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `BDA test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `BDA test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 180_000 });

  describe("binding registration", () => {
    test.provider("all 5 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/bindings`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).bound).toHaveLength(5);
      }),
    );
  });

  describe("InvokeDataAutomationAsync + GetDataAutomationStatus", () => {
    test.provider(
      "submits an async job against the bound project and polls its status",
      (_stack) =>
        Effect.gen(function* () {
          const arn = yield* getProfileArn;
          const invoked = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/invoke-async?profileArn=${encodeURIComponent(arn)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            invocationArn?: string;
            error?: string;
            message?: string;
          };
          // Proves project injection + bedrock:InvokeDataAutomationAsync +
          // the caller-permission S3 grants end-to-end. On failure the
          // fixture reports the typed tag + message here.
          expect(
            invoked.error === undefined
              ? "none"
              : `${invoked.error}: ${invoked.message}`,
          ).toBe("none");
          expect(invoked.invocationArn).toContain(
            ":data-automation-invocation/",
          );

          // Immediate status poll — the job settles asynchronously, so any
          // lifecycle status proves bedrock:GetDataAutomationStatus.
          const status = (yield* send(
            HttpClientRequest.get(
              `${baseUrl}/status?invocationArn=${encodeURIComponent(invoked.invocationArn)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as { status: string };
          expect([
            "Created",
            "InProgress",
            "Success",
            "ServiceError",
            "ClientError",
          ]).toContain(status.status);
        }),
      { timeout: 120_000 },
    );
  });

  describe("InvokeDataAutomation", () => {
    // The sync API needs a SYNC project and a non-empty input; the fixture
    // drives the binding through its typed ValidationException path — an IAM
    // gap would surface AccessDeniedException (a 500) instead of the tag.
    test.provider(
      "surfaces the typed ValidationException for an empty input",
      (_stack) =>
        Effect.gen(function* () {
          const arn = yield* getProfileArn;
          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/invoke-sync-validation?profileArn=${encodeURIComponent(arn)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as { tag: string };
          expect(response.tag).toBe("ValidationException");
        }),
      { timeout: 120_000 },
    );
  });
});
