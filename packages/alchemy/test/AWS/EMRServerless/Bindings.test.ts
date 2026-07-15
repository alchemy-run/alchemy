import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import * as emr from "@distilled.cloud/aws/emr-serverless";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import EmrServerlessTestFunctionLive, {
  BINDINGS_APP_NAME,
  BINDINGS_ROLE_NAME,
  EmrServerlessTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "EMRServerlessBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionArn: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policy). Retry only
// 5xx; a genuine 4xx/assertion failure surfaces immediately.
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

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const postJson = (path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

/** Find the fixture application out-of-band via its deterministic name. */
const findApplication = Effect.gen(function* () {
  const summary = yield* emr.listApplications.items({}).pipe(
    Stream.filter(
      (s) => s.name === BINDINGS_APP_NAME && s.state !== "TERMINATED",
    ),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );
  expect(summary).toBeDefined();
  return summary!;
});

describe.sequential("EMRServerless Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "EMRServerless test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("EMRServerless test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* EmrServerlessTestFunction;
        }).pipe(Effect.provide(EmrServerlessTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `EMRServerless test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `EMRServerless test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 240_000 });

  describe("binding registration", () => {
    test.provider("all 14 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(14);
      }),
    );
  });

  describe("ListJobRuns", () => {
    test.provider(
      "reads job runs through the injected application id",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/jobruns")) as { ids: string[] };
          expect(Array.isArray(response.ids)).toBe(true);
        }),
    );
  });

  describe("ListSessions", () => {
    test.provider("lists sessions on the bound application", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/sessions")) as { tag: string };
        expect(response.tag).toBe("ok");
      }),
    );
  });

  // Typed not-found probes: a ResourceNotFoundException (not
  // AccessDeniedException) proves the IAM grant covers the sub-resource ARN
  // and the application id was injected from the binding.
  describe("typed not-found probes", () => {
    // The session APIs validate the session id format before lookup, so a
    // well-formed-but-fake job-run-shaped id answers with the typed
    // ValidationException instead — either tag proves the IAM grant passed
    // authorization and the application id was injected.
    const probes: ReadonlyArray<
      readonly [
        name: string,
        method: "GET" | "POST",
        path: string,
        tags: readonly string[],
      ]
    > = [
      ["GetJobRun", "GET", "/jobrun", ["ResourceNotFoundException"]],
      [
        "GetDashboardForJobRun",
        "GET",
        "/jobrun-dashboard",
        ["ResourceNotFoundException"],
      ],
      [
        "ListJobRunAttempts",
        "GET",
        "/jobrun-attempts",
        ["ResourceNotFoundException"],
      ],
      [
        "CancelJobRun",
        "POST",
        "/jobrun-cancel-fake",
        ["ResourceNotFoundException"],
      ],
      [
        "GetSession",
        "GET",
        "/session",
        ["ResourceNotFoundException", "ValidationException"],
      ],
      [
        "GetSessionEndpoint",
        "GET",
        "/session-endpoint",
        ["ResourceNotFoundException", "ValidationException"],
      ],
      [
        "TerminateSession",
        "POST",
        "/session-terminate",
        ["ResourceNotFoundException", "ValidationException"],
      ],
    ] as const;

    for (const [name, method, path, tags] of probes) {
      test.provider(
        `${name} answers with a typed error (not AccessDenied)`,
        (_stack) =>
          Effect.gen(function* () {
            const response = (yield* method === "GET"
              ? getJson(path)
              : postJson(path)) as { tag: string; detail: string };
            expect(response.detail).not.toContain("not authorized");
            expect(tags).toContain(response.tag);
          }),
      );
    }
  });

  describe("GetResourceDashboard", () => {
    test.provider(
      "answers with the typed service-gate tag (see probe.test.ts)",
      (_stack) =>
        Effect.gen(function* () {
          // The service currently denies emr-serverless:GetResourceDashboard
          // for every caller (even Action:"*" admins) — the operation backs
          // the console dashboards and has not launched for API callers.
          // probe.test.ts pins that platform gate; here we assert the
          // binding surfaces the same typed tag end-to-end from the Lambda.
          const response = (yield* getJson("/resource-dashboard")) as {
            tag: string;
          };
          expect(response.tag).toBe("AccessDeniedException");
        }),
    );
  });

  describe("StartSession", () => {
    test.provider(
      "grant + PassRole reach the service (typed validation error)",
      (_stack) =>
        Effect.gen(function* () {
          // The fixture application has no interactive configuration, so the
          // service must answer with a typed validation error — reaching it
          // proves both the StartSession grant and the PassRole statement.
          const { Account } = yield* sts.getCallerIdentity({});
          const roleArn = `arn:aws:iam::${Account}:role/${BINDINGS_ROLE_NAME}`;
          const response = (yield* postJson(
            `/session-start?roleArn=${encodeURIComponent(roleArn)}`,
          )) as { tag: string };
          expect(response.tag).not.toBe("AccessDeniedException");
          expect(response.tag).not.toBe("ok");
        }),
    );
  });

  describe("application control + job run round trip", () => {
    test.provider(
      "start application, submit + cancel a job run, stop application",
      (_stack) =>
        Effect.gen(function* () {
          // 1. StartApplication (free — the fixture has no pre-init capacity).
          const started = (yield* postJson("/app-start")) as { tag: string };
          expect(started.tag).toBe("ok");

          // 2. Submit a job run (SparkPi from the EMR image).
          const { Account } = yield* sts.getCallerIdentity({});
          const roleArn = `arn:aws:iam::${Account}:role/${BINDINGS_ROLE_NAME}`;
          const run = (yield* postJson(
            `/jobrun-run?roleArn=${encodeURIComponent(roleArn)}`,
          )) as { jobRunId: string; arn: string };
          expect(run.jobRunId).toBeTruthy();
          expect(run.arn).toContain("/jobruns/");

          // 3. Cancel it immediately (no workers ever run).
          const cancelled = (yield* postJson(
            `/jobrun-cancel?id=${run.jobRunId}`,
          )) as { jobRunId: string };
          expect(cancelled.jobRunId).toBe(run.jobRunId);

          // 4. GetJobRun observes the cancellation.
          const detail = (yield* getJson(
            `/jobrun-detail?id=${run.jobRunId}`,
          )) as { jobRunId: string; state: string };
          expect(detail.jobRunId).toBe(run.jobRunId);
          expect(["CANCELLING", "CANCELLED"]).toContain(detail.state);

          // 5. The submitted run shows up in ListJobRuns.
          const listed = (yield* getJson("/jobruns")) as { ids: string[] };
          expect(listed.ids).toContain(run.jobRunId);

          // 6. Wait out-of-band for the application to settle in STARTED
          //    (stop is only valid once the start transition completes).
          const app = yield* findApplication;
          yield* emr.getApplication({ applicationId: app.id }).pipe(
            Effect.map((response) => response.application.state),
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (state): boolean => state !== "STARTING",
              times: 24,
            }),
          );

          // 7. StopApplication.
          const stopped = (yield* postJson("/app-stop")) as { tag: string };
          expect(stopped.tag).toBe("ok");
        }),
      { timeout: 240_000 },
    );
  });

  describe("consumeJobRunEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      (_stack) =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeJobRunEvents must
          // have materialized as a rule on the default bus with the Lambda as
          // target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
    );
  });
});
