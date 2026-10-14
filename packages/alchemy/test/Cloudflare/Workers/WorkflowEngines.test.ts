import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import * as Cloudflare from "@/Cloudflare";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import makeStack from "./fixtures/durable-workflow/stack.ts";
import type { PollResult } from "./fixtures/durable-workflow/worker.ts";

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

/** Poll a workflow until it's finished. */
const awaitResult = (url: string) =>
  request<PollResult>(url).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (result) => result.status === "success" || result.status === "failure",
      times: 45,
    }),
  );

/** A fresh id per run, so a retried test never reads an earlier attempt's journal. */
const freshId = (prefix: string) =>
  Effect.sync(() => `${prefix}-${crypto.randomUUID().slice(0, 8)}`);

describe.concurrent.each([
  { engine: "durable-object", dev: true, stage: "durable-workflow-local" },
  { engine: "durable-object", dev: false, stage: "durable-workflow-live" },
  { engine: "native", dev: true, stage: "native-engine-local" },
  { engine: "native", dev: false, stage: "native-engine-live" },
] as const)("Workflows on the $engine engine (dev: $dev)", ({ engine, dev, stage }) => {
  const state = dev ? inMemoryState() : Cloudflare.state();
  const Stack = makeStack(state, engine);
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
    providers: Cloudflare.providers(),
    state,
    dev,
    stage,
  });

  const stack = beforeAll(
    Effect.gen(function* () {
      yield* destroy(Stack);
      const output = yield* deploy(Stack);
      // A fresh workers.dev URL can take a while to start serving.
      yield* request(`${output.url}/ready`).pipe(
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
      );
      return output;
    }),
    { timeout: 120_000 },
  );
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 60_000 });

  test(
    "runs a workflow and returns its result",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const id = yield* freshId("greet");
      const result = yield* request<PollResult>(`${url}/run/Greet/${id}?name=sam`, "POST");
      expect(result).toEqual({ status: "success", value: "hello sam" });
      expect(yield* request<string[]>(`${url}/journal/${id}`)).toEqual(["greet", "log"]);
    }),
    { timeout: 90_000 },
  );

  test(
    "starting the same execution twice runs it once",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const id = yield* freshId("twice");
      const first = yield* request<{ executionId: string }>(`${url}/start/Greet/${id}`, "POST");
      const second = yield* request<{ executionId: string }>(`${url}/start/Greet/${id}`, "POST");
      expect(second.executionId).toBe(first.executionId);
      expect(yield* awaitResult(`${url}/poll/Greet/${id}`)).toEqual({
        status: "success",
        value: "hello world",
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
      yield* request(`${url}/start/Nap/${id}?seconds=3`, "POST");
      expect(yield* awaitResult(`${url}/poll/Nap/${id}`)).toEqual({
        status: "success",
        value: "rested",
      });
      expect(yield* request<string[]>(`${url}/journal/${id}`)).toEqual(["before", "after"]);
    }),
    { timeout: 90_000 },
  );

  test(
    "waits for a signal from outside",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const id = yield* freshId("approve");
      yield* request(`${url}/start/Approve/${id}`, "POST");
      // Suspended on the deferred, having run only its first activity.
      yield* request<string[]>(`${url}/journal/${id}`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (entries) => entries.length > 0,
          times: 30,
        }),
      );
      expect(yield* request<PollResult>(`${url}/poll/Approve/${id}`)).toEqual({
        status: "suspended",
      });
      yield* request(`${url}/approve/Approve/${id}?by=agent`, "POST");
      expect(yield* awaitResult(`${url}/poll/Approve/${id}`)).toEqual({
        status: "success",
        value: "approved by agent",
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
      const result = yield* request<PollResult>(`${url}/run/Checkout/${id}?decline=true`, "POST");
      expect(result).toEqual({
        status: "failure",
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
      const result = yield* request<PollResult>(`${url}/run/Checkout/${id}`, "POST");
      expect(result).toEqual({ status: "success", value: "charged" });
      expect(yield* request<string[]>(`${url}/journal/${id}`)).toEqual(["reserve", "charged"]);
    }),
    { timeout: 90_000 },
  );

  test(
    "interrupting a waiting workflow finishes it",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const id = yield* freshId("interrupt");
      yield* request(`${url}/start/Approve/${id}`, "POST");
      yield* request<string[]>(`${url}/journal/${id}`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (entries) => entries.length > 0,
          times: 30,
        }),
      );
      yield* request(`${url}/interrupt/Approve/${id}`, "POST");
      const result = yield* awaitResult(`${url}/poll/Approve/${id}`);
      expect(result.status).toBe("failure");
      expect(yield* request<string[]>(`${url}/journal/${id}`)).toEqual(["requested"]);
    }),
    { timeout: 90_000 },
  );

  test(
    "runs a child workflow",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const id = yield* freshId("parent");
      const result = yield* request<PollResult>(`${url}/run/Parent/${id}`, "POST");
      expect(result).toEqual({ status: "success", value: "parent got hello child" });
      expect(yield* request<string[]>(`${url}/journal/${id}-child`)).toEqual(["greet", "log"]);
      expect(yield* request<string[]>(`${url}/journal/${id}`)).toEqual(["parent:hello child"]);
    }),
    { timeout: 90_000 },
  );
});
