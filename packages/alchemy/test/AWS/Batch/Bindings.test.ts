import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import * as batch from "@distilled.cloud/aws/batch";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import BatchTestFunctionLive, { BatchTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BatchBindings");

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Fresh Lambda role + Batch permissions propagate eventually — the first
// submits can 500 with AccessDenied under the handler's `Effect.orDie`.
// Retry 5xx only; a genuine 4xx fails immediately.
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
      schedule: Schedule.exponential("1 second").pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
  );

const submit = (jobName: string) =>
  Effect.gen(function* () {
    const response = yield* send(
      HttpClientRequest.post(`${baseUrl}/submit`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ jobName }),
      ),
    );
    expect(response.status).toBe(200);
    return (yield* response.json) as {
      jobId: string;
      jobName: string;
      jobArn?: string;
    };
  });

/** Out-of-band job status via distilled. */
const jobStatus = (jobId: string) =>
  batch
    .describeJobs({ jobs: [jobId] })
    .pipe(Effect.map((res) => res.jobs?.[0]?.status));

describe("Batch Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("Batch test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "Batch test setup: deploying CE -> queue -> job definition -> Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* BatchTestFunction;
        }).pipe(Effect.provide(BatchTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds (sometimes over a
      // minute) to serve 200s.
      yield* HttpClient.get(`${baseUrl}/status?jobId=readiness-probe`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.fixed("2 seconds").pipe(
            Schedule.both(Schedule.recurs(75)),
          ),
        }),
      );
    }),
    { timeout: 300_000 },
  );
  afterAll(sharedStack.destroy(), { timeout: 300_000 });

  describe("SubmitJob", () => {
    test.provider(
      "submits a job that leaves the queue head (RUNNABLE or beyond)",
      () =>
        Effect.gen(function* () {
          const { jobId, jobName } = yield* submit("alchemy-e2e-echo");
          expect(jobName).toBe("alchemy-e2e-echo");
          expect(jobId).toBeTruthy();

          // Out-of-band: the job progresses past SUBMITTED/PENDING within
          // ~2 minutes on a healthy Fargate CE (bounded poll).
          const status = yield* jobStatus(jobId).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (s) =>
                s === "RUNNABLE" ||
                s === "STARTING" ||
                s === "RUNNING" ||
                s === "SUCCEEDED" ||
                s === "FAILED",
              times: 24,
            }),
          );
          expect(["RUNNABLE", "STARTING", "RUNNING", "SUCCEEDED"]).toContain(
            status,
          );
        }),
      { timeout: 240_000 },
    );

    // The full RUNNABLE→STARTING→SUCCEEDED round-trip takes 1-3 minutes of
    // Fargate provisioning — gated so the default suite stays in budget.
    test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
      "submitted echo job runs to SUCCEEDED (AWS_TEST_SLOW=1)",
      () =>
        Effect.gen(function* () {
          const { jobId } = yield* submit("alchemy-e2e-echo-succeed");
          const status = yield* jobStatus(jobId).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (s) => s === "SUCCEEDED" || s === "FAILED",
              times: 42,
            }),
          );
          expect(status).toBe("SUCCEEDED");
        }),
      { timeout: 480_000 },
    );
  });

  describe("DescribeJobs", () => {
    test.provider(
      "describes a submitted job from the runtime",
      () =>
        Effect.gen(function* () {
          const { jobId } = yield* submit("alchemy-e2e-describe");

          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/status?jobId=${jobId}`),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as {
            status?: string;
            jobQueue?: string;
          };
          expect(body.status).toBeTruthy();
          expect(body.jobQueue).toContain("job-queue/");
        }),
      { timeout: 120_000 },
    );
  });

  describe("TerminateJob", () => {
    test.provider(
      "terminates a submitted job from the runtime",
      () =>
        Effect.gen(function* () {
          const { jobId } = yield* submit("alchemy-e2e-terminate");

          const response = yield* send(
            HttpClientRequest.post(`${baseUrl}/terminate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                jobId,
                reason: "alchemy e2e terminate test",
              }),
            ),
          );
          expect(response.status).toBe(200);
          expect((yield* response.json) as object).toEqual({
            terminated: true,
          });

          // Out-of-band: a job terminated before running lands in FAILED.
          const status = yield* jobStatus(jobId).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (s) => s === "FAILED" || s === "SUCCEEDED",
              times: 24,
            }),
          );
          expect(status).toBe("FAILED");
        }),
      { timeout: 240_000 },
    );
  });
});
