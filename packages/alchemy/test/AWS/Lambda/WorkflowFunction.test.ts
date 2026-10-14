import * as Lambda from "@distilled.cloud/aws/lambda";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as AWS from "@/AWS";
import { executionNameOf } from "@/AWS/Lambda/DurableWorkflows.ts";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import type { Status } from "@/Workflows/index.ts";
import CallerLive, { WorkflowCaller } from "./fixtures/durable-workflows/caller.ts";
import HostLive, { TestWorkflows } from "./fixtures/durable-workflows/host.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "LambdaWorkflowFunction");

class NotReady extends Data.TaggedError("NotReady")<{ readonly message: string }> {}

type RunStatus = Status<unknown, unknown>;

/** A fresh id per run, so a retried test never reads an earlier attempt's execution. */
const freshId = (prefix: string) =>
  Effect.sync(() => `${prefix}-${crypto.randomUUID().slice(0, 8)}`);

describe(
  "Lambda WorkflowFunction",
  { tags: ["provider:aws", "provider:aws:lambda", "live"] },
  () => {
    let functionName: string;
    let url: string;

    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const outputs = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* TestWorkflows;
            const caller = yield* WorkflowCaller;
            return { functionName: host.functionName, url: caller.functionUrl };
          }).pipe(Effect.provide(Layer.mergeAll(HostLive, CallerLive))),
        );
        functionName = outputs.functionName;
        url = outputs.url!.replace(/\/$/, "");
        // A fresh Function URL can take a while to start serving.
        yield* request(`${url}/ready`).pipe(
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
        );
      }),
      { timeout: 600_000 },
    );
    afterAll(sharedStack.destroy(), { timeout: 120_000 });

    const request = <T>(target: string, method: "GET" | "POST" = "GET") =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* method === "POST" ? client.post(target) : client.get(target);
        const body = yield* response.text;
        if (response.status !== 200) {
          return yield* new NotReady({
            message: `${method} ${target}: ${response.status}: ${body}`,
          });
        }
        return (body.startsWith("{") ? JSON.parse(body) : body) as T;
      }).pipe(
        Effect.retry({
          while: (error) => error._tag === "NotReady",
          schedule: Schedule.spaced("1 second"),
          times: 5,
        }),
      );

    /** Start a run through the caller, and return how to read it. */
    const start = (workflow: string, id: string, query = "") =>
      Effect.map(
        request<{ executionId: string }>(`${url}/start/${workflow}/${id}${query}`, "POST"),
        ({ executionId }) => ({
          executionId,
          status: request<RunStatus>(`${url}/status/${workflow}/${id}?executionId=${executionId}`),
        }),
      );

    /** Read a run's status until it's finished. */
    const awaitResult = (status: Effect.Effect<RunStatus, unknown, HttpClient.HttpClient>) =>
      status.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (current) => current._tag !== "Running" && current._tag !== "NotStarted",
          times: 45,
        }),
      );

    /** The durable executions of a run, on the host. */
    const executionsOf = (workflow: string, executionId: string) =>
      Lambda.listDurableExecutionsByFunction({
        FunctionName: functionName,
        DurableExecutionName: executionNameOf(workflow, executionId),
      }).pipe(
        Effect.map((page) => page.DurableExecutions ?? []),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (executions) => executions.length > 0,
          times: 20,
        }),
      );

    /** The steps a run finished, in order, from its history. */
    const stepsOf = (workflow: string, executionId: string) =>
      Effect.gen(function* () {
        const [execution] = yield* executionsOf(workflow, executionId);
        const events = yield* Lambda.getDurableExecutionHistory
          .items({ DurableExecutionArn: execution!.DurableExecutionArn })
          .pipe(Stream.runCollect);
        return [...events]
          .filter((event) => event.StepSucceededDetails !== undefined && event.Name)
          .map((event) => event.Name!)
          .filter((name) => !name.startsWith("child"))
          .map((name) => name.replace(/\/\d+$/, ""));
      });

    test.provider(
      "runs a workflow and returns its result",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("greet");
          const run = yield* start("Greet", id, "?name=sam");
          expect(yield* awaitResult(run.status)).toEqual({
            _tag: "Completed",
            result: "hello sam",
          });
          expect(yield* stepsOf("Greet", run.executionId)).toEqual(["greet", "log"]);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "starting the same execution twice runs it once",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("twice");
          const first = yield* start("Greet", id);
          const second = yield* start("Greet", id);
          expect(second.executionId).toBe(first.executionId);
          expect(yield* awaitResult(first.status)).toEqual({
            _tag: "Completed",
            result: "hello world",
          });
          expect((yield* executionsOf("Greet", first.executionId)).length).toBe(1);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "sleeps durably between steps",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("nap");
          const run = yield* start("Nap", id, "?seconds=3");
          expect(yield* awaitResult(run.status)).toEqual({ _tag: "Completed", result: "rested" });
          expect(yield* stepsOf("Nap", run.executionId)).toEqual(["before", "after"]);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "waits for a signal from outside",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("approve");
          const run = yield* start("Approve", id);
          yield* request(
            `${url}/approve/Approve/${id}?executionId=${run.executionId}&by=agent`,
            "POST",
          );
          expect(yield* awaitResult(run.status)).toEqual({
            _tag: "Completed",
            result: "approved by agent",
          });
          expect(yield* stepsOf("Approve", run.executionId)).toEqual(["requested", "approved"]);
        }),
      { timeout: 180_000 },
    );

    test.provider(
      "a typed failure runs compensations",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("declined");
          const run = yield* start("Checkout", id, "?decline=true");
          expect(yield* awaitResult(run.status)).toEqual({
            _tag: "Failed",
            error: { _tag: "Declined", reason: "card declined" },
          });
          expect(yield* stepsOf("Checkout", run.executionId)).toEqual([
            "reserve",
            "charge",
            "release",
          ]);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "a successful workflow keeps its steps",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("charged");
          const run = yield* start("Checkout", id);
          expect(yield* awaitResult(run.status)).toEqual({ _tag: "Completed", result: "charged" });
          expect(yield* stepsOf("Checkout", run.executionId)).toEqual(["reserve", "charge"]);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "interrupting a waiting workflow finishes it",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("interrupt");
          const run = yield* start("Approve", id);
          // Interrupt once it's waiting on its signal.
          yield* stepsOf("Approve", run.executionId).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (steps) => steps.includes("requested"),
              times: 30,
            }),
          );
          yield* request(`${url}/interrupt/Approve/${id}?executionId=${run.executionId}`, "POST");
          expect(yield* awaitResult(run.status)).toEqual({ _tag: "Interrupted" });
          expect(yield* stepsOf("Approve", run.executionId)).toEqual(["requested"]);
          // Woken through its callback and finished by itself, not stopped.
          const [execution] = yield* executionsOf("Approve", run.executionId);
          expect(execution!.Status).toBe("SUCCEEDED");
        }),
      { timeout: 180_000 },
    );

    test.provider(
      "runs a child workflow",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("parent");
          const run = yield* start("Parent", id);
          expect(yield* awaitResult(run.status)).toEqual({
            _tag: "Completed",
            result: "parent got hello child",
          });
        }),
      { timeout: 180_000 },
    );
  },
);
