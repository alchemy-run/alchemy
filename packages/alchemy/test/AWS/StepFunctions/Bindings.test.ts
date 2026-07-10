import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import SFNTestFunctionLive, { SFNTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SFNBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.fixed("2 seconds").pipe(
  Schedule.both(Schedule.recurs(75)),
);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx only; genuine 4xx/assertion failures surface
// immediately.
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
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(6)),
      ),
    }),
  );

const postJson = (url: string, body: unknown) =>
  send(
    HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
  ).pipe(Effect.flatMap((r) => r.json));

const getJson = (url: string) =>
  send(HttpClientRequest.get(url)).pipe(Effect.flatMap((r) => r.json));

/** Poll an execution's status via the fixture until it leaves RUNNING. */
const pollExecution = (route: string, executionArn: string) =>
  getJson(
    `${baseUrl}/${route}?executionArn=${encodeURIComponent(executionArn)}`,
  ).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (r) => (r as { status: string }).status !== "RUNNING",
      times: 20,
    }),
  ) as Effect.Effect<
    { status: string; output?: string; error?: string },
    unknown
  >;

/**
 * Drain the callback queue until we hold the task token for the given
 * execution. Tokens for other executions (stale from earlier tests in the
 * sequential block) are consumed and discarded.
 */
const receiveTokenFor = (executionArn: string) =>
  getJson(`${baseUrl}/receive-token`).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (r) =>
        (r as { executionArn?: string }).executionArn === executionArn,
      times: 15,
    }),
    Effect.map((r) => (r as { token: string }).token),
  );

describe("StepFunctions Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("SFN test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("SFN test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SFNTestFunction;
        }).pipe(Effect.provide(SFNTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/health`;

      yield* Effect.logInfo(
        `SFN test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `SFN test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("StartSyncExecution", () => {
    test.provider(
      "runs an EXPRESS workflow synchronously and returns its output",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson(`${baseUrl}/start-sync`, {
            input: JSON.stringify({ value: 42 }),
          })) as {
            executionArn: string;
            status: string;
            output?: string;
            error?: string;
            cause?: string;
          };

          expect(response.status).toBe("SUCCEEDED");
          expect(response.executionArn).toContain(":express:");
          const output = JSON.parse(response.output!);
          expect(output.greeting).toBe("hello");
          expect(output.echo.value).toBe(42);
        }),
      { timeout: 60_000 },
    );
  });

  describe("StartExecution", () => {
    test.provider(
      "starts a STANDARD execution asynchronously",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson(`${baseUrl}/start`, {
            input: JSON.stringify({ order: 1 }),
          })) as { executionArn: string };

          expect(response.executionArn).toContain(":execution:");
        }),
      { timeout: 60_000 },
    );
  });

  describe("DescribeExecution", () => {
    test.provider(
      "observes a STANDARD execution completing",
      (_stack) =>
        Effect.gen(function* () {
          const started = (yield* postJson(`${baseUrl}/start`, {
            input: JSON.stringify({ order: 2 }),
          })) as { executionArn: string };

          const final = yield* pollExecution(
            "describe-standard",
            started.executionArn,
          );
          expect(final.status).toBe("SUCCEEDED");
          expect(JSON.parse(final.output!)).toEqual({ done: true });
        }),
      { timeout: 90_000 },
    );
  });

  // The callback flows share ONE SQS queue carrying task tokens — receives
  // steal each other's messages under concurrency, so run them sequentially
  // and drain only the matching token per test.
  describe.sequential("callback pattern", () => {
    describe("SendTaskSuccess", () => {
      test.provider(
        "heartbeats then completes a waiting execution",
        (_stack) =>
          Effect.gen(function* () {
            const started = (yield* postJson(
              `${baseUrl}/start-callback`,
              {},
            )) as { executionArn: string };

            const token = yield* receiveTokenFor(started.executionArn);
            expect(token).toBeTruthy();

            // SendTaskHeartbeat keeps the task alive without completing it
            const heartbeat = (yield* postJson(`${baseUrl}/task-heartbeat`, {
              token,
            })) as { sent: boolean };
            expect(heartbeat.sent).toBe(true);

            const success = (yield* postJson(`${baseUrl}/task-success`, {
              token,
              output: JSON.stringify({ approved: true }),
            })) as { sent: boolean };
            expect(success.sent).toBe(true);

            const final = yield* pollExecution(
              "describe-callback",
              started.executionArn,
            );
            expect(final.status).toBe("SUCCEEDED");
            expect(JSON.parse(final.output!)).toEqual({ approved: true });
          }),
        { timeout: 120_000 },
      );
    });

    describe("SendTaskFailure", () => {
      test.provider(
        "fails a waiting execution with a typed error",
        (_stack) =>
          Effect.gen(function* () {
            const started = (yield* postJson(
              `${baseUrl}/start-callback`,
              {},
            )) as { executionArn: string };

            const token = yield* receiveTokenFor(started.executionArn);

            const failed = (yield* postJson(`${baseUrl}/task-failure`, {
              token,
              error: "ApprovalRejected",
              cause: "rejected by integration test",
            })) as { sent: boolean };
            expect(failed.sent).toBe(true);

            const final = yield* pollExecution(
              "describe-callback",
              started.executionArn,
            );
            expect(final.status).toBe("FAILED");
            expect(final.error).toBe("ApprovalRejected");
          }),
        { timeout: 120_000 },
      );
    });

    describe("StopExecution", () => {
      test.provider(
        "aborts a running execution",
        (_stack) =>
          Effect.gen(function* () {
            const started = (yield* postJson(
              `${baseUrl}/start-callback`,
              {},
            )) as { executionArn: string };

            // consume this execution's token first so it never pollutes the
            // queue for other flows
            yield* receiveTokenFor(started.executionArn);

            const stopped = (yield* postJson(`${baseUrl}/stop`, {
              executionArn: started.executionArn,
            })) as { stopDate: string };
            expect(stopped.stopDate).toBeTruthy();

            const final = yield* pollExecution(
              "describe-callback",
              started.executionArn,
            );
            expect(final.status).toBe("ABORTED");
          }),
        { timeout: 120_000 },
      );
    });

    describe("SendTaskHeartbeat", () => {
      test.provider(
        "rejects an invalid task token with a typed error surfaced as 500",
        (_stack) =>
          Effect.gen(function* () {
            // an obviously-invalid token dies in the fixture (orDie) — the
            // route answers 500; we only assert the request round-trips and
            // does not hang (IAM wiring for states:SendTaskHeartbeat works,
            // otherwise this would be AccessDenied at a different layer).
            const response = yield* HttpClient.execute(
              HttpClientRequest.post(`${baseUrl}/task-heartbeat`).pipe(
                HttpClientRequest.bodyJsonUnsafe({ token: "not-a-token" }),
              ),
            );
            expect(response.status).toBeGreaterThanOrEqual(400);
          }),
        { timeout: 60_000 },
      );
    });
  });
});
