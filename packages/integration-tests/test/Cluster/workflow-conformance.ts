/**
 * The shared workflow engine conformance cases, driven over HTTP against the
 * front, which starts and reads runs through `Cluster.WorkflowEngine`.
 */
import { expect } from "@alchemy.run/test";
import type { Status } from "alchemy/Workflows";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";

class NotReady extends Data.TaggedError("NotReady")<{ readonly message: string }> {}

type RunStatus = Status<unknown, unknown>;

const request = <T>(target: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(target);
    const body = yield* response.text;
    if (response.status !== 200) {
      return yield* new NotReady({ message: `${target}: ${response.status}: ${body}` });
    }
    return (body.startsWith("{") || body.startsWith("[") ? JSON.parse(body) : body) as T;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "NotReady",
      schedule: Schedule.spaced("1 second"),
      times: 5,
    }),
  );

/** A fresh id per run, so a retried test never reads an earlier attempt's journal. */
const freshId = (prefix: string) =>
  Effect.sync(() => `${prefix}-${crypto.randomUUID().slice(0, 8)}`);

type TestFn = (name: string, effect: Effect.Effect<void, unknown, any>, options?: object) => void;

export const workflowConformanceTests = (
  test: TestFn,
  {
    baseUrl,
    kind,
  }: {
    baseUrl: () => string;
    /** Whether the host under test runs in a real cloud or on this machine. */
    kind: "live" | "local";
  },
) => {
  const options = { timeout: 90_000, tags: [kind] };
  const url = () => `${baseUrl()}/wf`;

  const start = (workflow: string, id: string, query = "") =>
    Effect.map(
      request<{ executionId: string }>(`${url()}/start/${workflow}/${id}${query}`),
      ({ executionId }) => ({
        executionId,
        status: request<RunStatus>(`${url()}/status/${workflow}/${id}?executionId=${executionId}`),
      }),
    );

  const awaitResult = (status: Effect.Effect<RunStatus, unknown, HttpClient.HttpClient>) =>
    status.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (current) => current._tag !== "Running" && current._tag !== "NotStarted",
        times: 60,
      }),
    );

  const journal = (id: string) => request<string[]>(`${url()}/journal/${id}`);

  const awaitJournal = (id: string) =>
    journal(id).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("500 millis"),
        until: (entries) => entries.length > 0,
        times: 30,
      }),
    );

  test(
    "runs a workflow and returns its result",
    Effect.gen(function* () {
      const id = yield* freshId("greet");
      expect(yield* request<RunStatus>(`${url()}/run/Greet/${id}?name=sam`)).toEqual({
        _tag: "Completed",
        result: "hello sam",
      });
      expect(yield* journal(id)).toEqual(["greet", "log"]);
    }),
    options,
  );

  test(
    "starting the same execution twice runs it once",
    Effect.gen(function* () {
      const id = yield* freshId("twice");
      const first = yield* start("Greet", id);
      const second = yield* start("Greet", id);
      expect(second.executionId).toBe(first.executionId);
      expect(yield* awaitResult(first.status)).toEqual({
        _tag: "Completed",
        result: "hello world",
      });
      expect(yield* journal(id)).toEqual(["greet", "log"]);
    }),
    options,
  );

  test(
    "sleeps durably between activities",
    Effect.gen(function* () {
      const id = yield* freshId("nap");
      const run = yield* start("Nap", id, "?seconds=3");
      expect(yield* awaitResult(run.status)).toEqual({ _tag: "Completed", result: "rested" });
      expect(yield* journal(id)).toEqual(["before", "after"]);
    }),
    options,
  );

  test(
    "waits for a signal from outside",
    Effect.gen(function* () {
      const id = yield* freshId("approve");
      const run = yield* start("Approve", id);
      yield* awaitJournal(id);
      // The first activity is journaled before the run suspends on the deferred.
      const waiting = yield* run.status.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("200 millis"),
          until: (status) => status._tag !== "NotStarted",
          times: 25,
        }),
      );
      expect(waiting).toEqual({ _tag: "Running" });
      yield* request(`${url()}/approve/Approve/${id}?executionId=${run.executionId}&by=agent`);
      expect(yield* awaitResult(run.status)).toEqual({
        _tag: "Completed",
        result: "approved by agent",
      });
      expect(yield* journal(id)).toEqual(["requested", "approved:agent"]);
    }),
    options,
  );

  test(
    "a typed failure runs compensations",
    Effect.gen(function* () {
      const id = yield* freshId("declined");
      expect(yield* request<RunStatus>(`${url()}/run/Checkout/${id}?decline=true`)).toEqual({
        _tag: "Failed",
        error: { _tag: "Declined", reason: "card declined" },
      });
      expect(yield* journal(id)).toEqual(["reserve", "declined", "release"]);
    }),
    options,
  );

  test(
    "a successful workflow keeps its steps",
    Effect.gen(function* () {
      const id = yield* freshId("charged");
      expect(yield* request<RunStatus>(`${url()}/run/Checkout/${id}`)).toEqual({
        _tag: "Completed",
        result: "charged",
      });
      expect(yield* journal(id)).toEqual(["reserve", "charged"]);
    }),
    options,
  );

  test(
    "interrupting a waiting workflow finishes it",
    Effect.gen(function* () {
      const id = yield* freshId("interrupt");
      const run = yield* start("Approve", id);
      yield* awaitJournal(id);
      yield* request(`${url()}/interrupt/Approve/${id}?executionId=${run.executionId}`);
      expect(yield* awaitResult(run.status)).toEqual({ _tag: "Interrupted" });
      expect(yield* journal(id)).toEqual(["requested"]);
    }),
    options,
  );

  test(
    "runs through Workflows.RunWorkflow on Cluster.WorkflowEngine",
    Effect.gen(function* () {
      const id = yield* freshId("portable");
      expect(yield* request<RunStatus>(`${url()}/portable/Greet/${id}?name=sam`)).toEqual({
        _tag: "Completed",
        result: "hello sam",
      });
      expect(yield* journal(id)).toEqual(["greet", "log"]);
    }),
    options,
  );

  test(
    "runs a child workflow",
    Effect.gen(function* () {
      const id = yield* freshId("parent");
      expect(yield* request<RunStatus>(`${url()}/run/Parent/${id}`)).toEqual({
        _tag: "Completed",
        result: "parent got hello child",
      });
      expect(yield* journal(`${id}-child`)).toEqual(["greet", "log"]);
      expect(yield* journal(id)).toEqual(["parent:hello child"]);
    }),
    options,
  );
};
