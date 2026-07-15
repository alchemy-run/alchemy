import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as appflow from "@distilled.cloud/aws/appflow";
import * as s3 from "@distilled.cloud/aws/s3";
import * as sqs from "@distilled.cloud/aws/sqs";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {
  AppFlowApiFunction,
  AppFlowApiFunctionLive,
  FLOW_BUCKET,
  FLOW_NAME,
  FlowBucket,
  FlowFixture,
} from "./handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

// The full fixture: bucket + flow + events queue + the API function with all
// four Flow bindings and the flowEvents consume loop.
const program = Effect.gen(function* () {
  const { flow, eventsQueue } = yield* FlowFixture;
  const fn = yield* AppFlowApiFunction;
  return { fn, flow, eventsQueue };
}).pipe(Effect.provide(AppFlowApiFunctionLive));

// Lambda Function URLs cold-start and a fresh role's IAM grants are
// eventually consistent; retrying on any non-200 lets the FIRST request wait
// through that window.
const readinessSchedule = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(45),
]);

// Function URLs come back with a trailing slash; strip it before joining so
// pathnames match the fixture's routes.
const urlOf = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/+$/, "")}${path}`;

const getJson = (baseUrl: string, path: string) =>
  HttpClient.get(urlOf(baseUrl, path)).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`Request failed: ${response.status}`)),
    ),
    Effect.retry({ schedule: readinessSchedule }),
  );

const postJson = (baseUrl: string, path: string, body: unknown) =>
  HttpClient.execute(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(urlOf(baseUrl, path)),
      body,
    ),
  ).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`Request failed: ${response.status}`)),
    ),
    Effect.retry({ schedule: readinessSchedule }),
  );

class ExecutionNotFinished extends Data.TaggedError("ExecutionNotFinished") {}

/** Poll the fixture's /executions route until the given run finishes. */
const waitForExecution = (baseUrl: string, executionId: string) =>
  getJson(baseUrl, "/executions").pipe(
    Effect.flatMap((response) => {
      const record = (
        response as {
          flowExecutions: Array<{
            executionId?: string;
            executionStatus?: string;
          }>;
        }
      ).flowExecutions.find((r) => r.executionId === executionId);
      return record?.executionStatus && record.executionStatus !== "InProgress"
        ? Effect.succeed(record)
        : Effect.fail(new ExecutionNotFinished());
    }),
    Effect.retry({
      while: (e): boolean => e instanceof ExecutionNotFinished,
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(18),
      ]),
    }),
  );

class EventNotDelivered extends Data.TaggedError("EventNotDelivered") {}

interface DeliveredFlowEvent {
  detailType: string;
  detail: { "flow-name"?: string; status?: string; "execution-id"?: string };
}

/** Poll the SQS sink until a run report for our flow arrives. */
const waitForFlowEvent = (queueUrl: string) =>
  Effect.gen(function* () {
    const result = yield* sqs.receiveMessage({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 5,
    });
    const match = (result.Messages ?? [])
      .flatMap((message) =>
        message.Body ? [JSON.parse(message.Body) as DeliveredFlowEvent] : [],
      )
      .find((body) => body.detail?.["flow-name"] === FLOW_NAME);
    if (!match) {
      return yield* Effect.fail(new EventNotDelivered());
    }
    return match;
  }).pipe(
    Effect.retry({
      while: (e): boolean => e._tag === "EventNotDelivered",
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(17),
      ]),
    }),
  );

const assertFlowGone = (flowName: string) =>
  Effect.gen(function* () {
    const result = yield* appflow.describeFlow({ flowName }).pipe(
      Effect.map(() => "present" as const),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (result === "present") {
      return yield* Effect.fail(new Error(`Flow '${flowName}' still exists`));
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(8)]),
    }),
  );

// One sequential lifecycle: the S3-to-S3 path is credential-free, but the
// source prefix must be seeded BEFORE the flow exists, so the bucket deploys
// first, the object lands out-of-band, then the full fixture deploys.
test.provider(
  "StartFlow / DescribeFlowExecutionRecords / StopFlow / CancelFlowExecutions / flowEvents",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Phase 1: the bucket alone; seed the source prefix.
      yield* stack.deploy(FlowBucket);
      yield* s3.putObject({
        Bucket: FLOW_BUCKET,
        Key: "input/data.csv",
        Body: new TextEncoder().encode("id,name\n1,alpha\n2,beta\n"),
        ContentType: "text/csv",
      });

      // Phase 2: flow + queue + function with all bindings.
      const outputs = yield* stack.deploy(program);
      const url = outputs.fn.functionUrl!;
      const queueUrl = outputs.eventsQueue.queueUrl;
      expect(outputs.flow.flowName).toBe(FLOW_NAME);
      expect(url).toBeDefined();

      yield* getJson(url, "/ready");

      // StartFlow — trigger an on-demand run.
      const started = (yield* postJson(url, "/start", {})) as {
        executionId?: string;
        flowArn?: string;
      };
      expect(started.executionId).toBeTruthy();
      expect(started.flowArn).toContain(":appflow:");

      // StopFlow — on-demand flows cannot be stopped; the binding surfaces
      // the typed tag.
      const stopped = (yield* postJson(url, "/stop", {})) as {
        ok: boolean;
        error?: string;
      };
      expect(stopped.ok).toBe(false);
      expect(stopped.error).toBe("UnsupportedOperationException");

      // DescribeFlowExecutionRecords — poll until the run leaves InProgress.
      const record = yield* waitForExecution(url, started.executionId!);
      expect(record.executionId).toBe(started.executionId);
      expect(record.executionStatus).toBeTruthy();

      // flowEvents — the consume loop forwards this flow's run report into
      // the SQS sink.
      const event = yield* waitForFlowEvent(queueUrl);
      expect(event.detail["flow-name"]).toBe(FLOW_NAME);
      expect(event.detailType).toContain("Flow Run Report");

      // CancelFlowExecutions — start a second run and cancel it right away.
      // The run may already be finishing, so only the response shape is
      // asserted (finished runs land in invalidExecutions).
      const second = (yield* postJson(url, "/start", {})) as {
        executionId?: string;
      };
      const canceled = (yield* postJson(url, "/cancel", {
        executionIds: [second.executionId],
      })) as { ok: boolean; invalidExecutions?: string[] };
      expect(canceled.ok).toBe(true);
      expect(Array.isArray(canceled.invalidExecutions)).toBe(true);

      // Destroy and verify the flow is gone.
      yield* stack.destroy();
      yield* assertFlowGone(FLOW_NAME);
    }),
  { timeout: 420_000 },
);
