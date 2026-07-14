import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import * as iam from "@distilled.cloud/aws/iam";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import XRayTestFunctionLive, { XRayTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "XRayBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load. Budget ~150s of
// readiness polling.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionName: string;
let roleName: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// parallel load (cold re-init, IAM propagation). Retry 5xx only; a genuine
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

describe("XRay Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("XRay test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("XRay test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* XRayTestFunction;
        }).pipe(Effect.provide(XRayTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionName = attrs.functionName;
      roleName = attrs.roleName;

      const readinessUrl = `${baseUrl}/ping`;
      yield* Effect.logInfo(
        `XRay test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `XRay test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("Function tracing", () => {
    test.provider(
      "deployed function has Active tracing and the X-Ray write policy",
      (_stack) =>
        Effect.gen(function* () {
          const config = yield* Lambda.getFunctionConfiguration({
            FunctionName: functionName,
          });
          expect(config.TracingConfig?.Mode).toBe("Active");

          const attached = yield* iam.listAttachedRolePolicies({
            RoleName: roleName,
          });
          const arns = (attached.AttachedPolicies ?? []).map(
            (policy) => policy.PolicyArn,
          );
          expect(arns).toContain(
            "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess",
          );
        }),
    );
  });

  describe("GetTraceSummaries", () => {
    test.provider("queries trace summaries through the binding", (_stack) =>
      Effect.gen(function* () {
        // Proves the deploy-time IAM binding: the call succeeds (200) even
        // when no traces have been ingested yet.
        const response = yield* send(
          HttpClientRequest.get(
            `${baseUrl}/trace-summaries?service=${functionName}`,
          ),
        );
        expect(response.status).toBe(200);
        const body = (yield* response.json) as { traceIds: string[] };
        expect(Array.isArray(body.traceIds)).toBe(true);
      }),
    );
  });

  describe("BatchGetTraces", () => {
    test.provider("fetches traces by id through the binding", (_stack) =>
      Effect.gen(function* () {
        // A syntactically valid, recent, but non-existent trace id proves the
        // IAM binding without depending on ingestion latency. The embedded
        // timestamp must be current — X-Ray rejects ids outside its retention
        // window.
        const epochHex = yield* Effect.sync(() =>
          Math.floor(Date.now() / 1000).toString(16),
        );
        const response = yield* send(
          HttpClientRequest.get(
            `${baseUrl}/batch-get-traces?ids=1-${epochHex}-abcdef0123456789abcdef01`,
          ),
        );
        expect(response.status).toBe(200);
        const body = (yield* response.json) as {
          traces: Array<{ id: string; segments: number }>;
          unprocessed: string[];
        };
        expect(body.traces).toEqual([]);
      }),
    );
  });

  describe("Trace ingestion", () => {
    // X-Ray trace ingestion typically lands within 5-30s of the invocation,
    // but can occasionally exceed that under load. The poll below budgets
    // ~90s (18 x 5s); a full traced round-trip (invoke -> summary -> batch
    // fetch) is asserted once a trace id shows up.
    test.provider(
      "invoking the traced function produces a queryable trace",
      (_stack) =>
        Effect.gen(function* () {
          // Generate a handful of sampled invocations.
          yield* Effect.forEach(
            [1, 2, 3],
            () => send(HttpClientRequest.get(`${baseUrl}/ping`)),
            { discard: true },
          );

          const traceIds = yield* send(
            HttpClientRequest.get(
              `${baseUrl}/trace-summaries?service=${functionName}`,
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map((body) => (body as { traceIds: string[] }).traceIds),
            // A throttled poll iteration is an empty result, not a failure —
            // the bounded repeat keeps polling.
            Effect.catchTag("TransientUpstream", () =>
              Effect.succeed([] as string[]),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (ids) => ids.length > 0,
              times: 18,
            }),
          );
          expect(traceIds.length).toBeGreaterThan(0);

          // Round-trip the discovered id through BatchGetTraces.
          const batch = (yield* send(
            HttpClientRequest.get(
              `${baseUrl}/batch-get-traces?ids=${traceIds[0]}`,
            ),
          ).pipe(Effect.flatMap((response) => response.json))) as {
            traces: Array<{ id: string; segments: number }>;
          };
          expect(batch.traces.length).toBe(1);
          expect(batch.traces[0].id).toBe(traceIds[0]);
          expect(batch.traces[0].segments).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });
});
