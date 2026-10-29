import * as AWS from "@alchemy.run/aws";
import * as Celld from "@alchemy.run/celld";
import * as CelldAWS from "@alchemy.run/celld/AWS";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { WorkflowCells } from "./fixtures/durable-workflow/fleet.ts";
import DurableWorkflowWorker, { type Status } from "./fixtures/durable-workflow/worker.ts";

const testOptions = {
  providers: Layer.mergeAll(
    AWS.providers(),
    Celld.providers(),
    CelldAWS.EcsFleet().pipe(Layer.provide(CelldAWS.EcsTaskManagement())),
  ),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "CelldWorkflowEngine", import.meta.url);

class NotReady extends Data.TaggedError("NotReady")<{ readonly message: string }> {}

const request = <T>(url: string, method: "GET" | "POST" = "GET") =>
  Effect.gen(function* () {
    const client = HttpClient.mapRequest(
      yield* HttpClient.HttpClient,
      HttpClientRequest.setHeaders({ connection: "close", "cache-control": "no-cache" }),
    );
    const response = yield* method === "POST" ? client.post(url) : client.get(url);
    const body = yield* response.text;
    if (response.status !== 200) {
      return yield* new NotReady({ message: `${method} ${url}: HTTP ${response.status}: ${body}` });
    }
    return (body.startsWith("{") || body.startsWith("[") ? JSON.parse(body) : body) as T;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "NotReady",
      schedule: Schedule.spaced("1 second"),
      times: 10,
    }),
  );

type RunStatus = Status<unknown, unknown>;

/** Start a run without waiting, and return the URL that reads its status. */
const start = (url: string, workflow: string, id: string, query = "") =>
  Effect.map(
    request<{ executionId: string }>(`${url}/start/${workflow}/${id}${query}`, "POST"),
    ({ executionId }) => ({
      executionId,
      status: `${url}/status/${workflow}/${id}?executionId=${executionId}`,
    }),
  );

/** Read a run's status until it's finished. */
const awaitResult = (url: string) =>
  request<RunStatus>(url).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status._tag !== "Running" && status._tag !== "NotStarted",
      times: 45,
    }),
  );

/** A fresh id per run, so a retried test never reads an earlier attempt's journal. */
const freshId = (prefix: string) =>
  Effect.sync(() => `${prefix}-${crypto.randomUUID().slice(0, 8)}`);

// The same conformance cases as the Cloudflare engines, on a Celld fleet.
describe.skipIf(!!process.env.FAST)(
  "Workflows on Celld Durable Objects",
  { tags: ["provider:celld", "provider:aws", "provider:aws:ecs", "live"] },
  () => {
    let baseUrl = "";
    const stack = Effect.sync(() => ({ url: baseUrl }));

    beforeAll(
      Effect.gen(function* () {
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const { url } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const app = yield* Celld.Application("WorkflowApp", {
              entrypoint: DurableWorkflowWorker,
            });
            return { url: app.url };
          }).pipe(Effect.provide(Celld.Fleet.layer(WorkflowCells))),
        );
        baseUrl = String(url).replace(/\/+$/, "");
        // The load balancer registers the node after activation.
        yield* request(`${baseUrl}/ready`).pipe(
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
        );
      }),
      { timeout: 1_200_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
      timeout: 1_800_000,
    });

    test(
      "runs a workflow and returns its result",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const id = yield* freshId("greet");
        const result = yield* request<RunStatus>(`${url}/run/Greet/${id}?name=sam`, "POST");
        expect(result).toEqual({ _tag: "Completed", result: "hello sam" });
        expect(yield* request<string[]>(`${url}/journal/${id}`)).toEqual(["greet", "log"]);
      }),
      { timeout: 90_000 },
    );

    test(
      "starting the same execution twice runs it once",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const id = yield* freshId("twice");
        const first = yield* start(url, "Greet", id);
        const second = yield* start(url, "Greet", id);
        expect(second.executionId).toBe(first.executionId);
        expect(yield* awaitResult(first.status)).toEqual({
          _tag: "Completed",
          result: "hello world",
        });
        expect(yield* request<string[]>(`${url}/journal/${id}`)).toEqual(["greet", "log"]);
      }),
      { timeout: 90_000 },
    );

    test(
      "sleeps durably between activities",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const id = yield* freshId("nap");
        const run = yield* start(url, "Nap", id, "?seconds=3");
        expect(yield* awaitResult(run.status)).toEqual({ _tag: "Completed", result: "rested" });
        expect(yield* request<string[]>(`${url}/journal/${id}`)).toEqual(["before", "after"]);
      }),
      { timeout: 90_000 },
    );

    test(
      "waits for a signal from outside",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const id = yield* freshId("approve");
        const run = yield* start(url, "Approve", id);
        // Suspended on the deferred, having run only its first activity.
        yield* request<string[]>(`${url}/journal/${id}`).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            until: (entries) => entries.length > 0,
            times: 30,
          }),
        );
        expect(yield* request<RunStatus>(run.status)).toEqual({ _tag: "Running" });
        yield* request(
          `${url}/approve/Approve/${id}?executionId=${run.executionId}&by=agent`,
          "POST",
        );
        expect(yield* awaitResult(run.status)).toEqual({
          _tag: "Completed",
          result: "approved by agent",
        });
        expect(yield* request<string[]>(`${url}/journal/${id}`)).toEqual([
          "requested",
          "approved:agent",
        ]);
      }),
      { timeout: 90_000 },
    );

    test(
      "a typed failure runs compensations",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const id = yield* freshId("declined");
        const result = yield* request<RunStatus>(`${url}/run/Checkout/${id}?decline=true`, "POST");
        expect(result).toEqual({
          _tag: "Failed",
          error: { _tag: "Declined", reason: "card declined" },
        });
        expect(yield* request<string[]>(`${url}/journal/${id}`)).toEqual([
          "reserve",
          "declined",
          "release",
        ]);
      }),
      { timeout: 90_000 },
    );

    test(
      "a successful workflow keeps its steps",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const id = yield* freshId("charged");
        const result = yield* request<RunStatus>(`${url}/run/Checkout/${id}`, "POST");
        expect(result).toEqual({ _tag: "Completed", result: "charged" });
        expect(yield* request<string[]>(`${url}/journal/${id}`)).toEqual(["reserve", "charged"]);
      }),
      { timeout: 90_000 },
    );

    test(
      "interrupting a waiting workflow finishes it",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const id = yield* freshId("interrupt");
        const run = yield* start(url, "Approve", id);
        yield* request<string[]>(`${url}/journal/${id}`).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            until: (entries) => entries.length > 0,
            times: 30,
          }),
        );
        yield* request(`${url}/interrupt/Approve/${id}?executionId=${run.executionId}`, "POST");
        expect(yield* awaitResult(run.status)).toEqual({ _tag: "Interrupted" });
        expect(yield* request<string[]>(`${url}/journal/${id}`)).toEqual(["requested"]);
      }),
      { timeout: 90_000 },
    );

    test(
      "runs a child workflow",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const id = yield* freshId("parent");
        const result = yield* request<RunStatus>(`${url}/run/Parent/${id}`, "POST");
        expect(result).toEqual({ _tag: "Completed", result: "parent got hello child" });
        expect(yield* request<string[]>(`${url}/journal/${id}-child`)).toEqual(["greet", "log"]);
        expect(yield* request<string[]>(`${url}/journal/${id}`)).toEqual(["parent:hello child"]);
      }),
      { timeout: 90_000 },
    );
  },
);
