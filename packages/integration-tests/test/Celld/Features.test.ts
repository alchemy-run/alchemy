import * as AWS from "@alchemy.run/aws";
import * as Celld from "@alchemy.run/celld";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "alchemy/Test/Alchemy";
import * as Core from "alchemy/Test/Core";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { FeatureApi, FeatureCells, FeatureService } from "./fixtures/features/resources.ts";
import FeatureServiceLive from "./fixtures/features/service.ts";
import FeatureApiLive from "./fixtures/features/worker.ts";

const testOptions = {
  providers: Layer.mergeAll(AWS.providers(), Celld.providers(), Celld.EcsFleet()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "CelldFeatures", import.meta.url);

class NotReady extends Data.TaggedError("NotReady")<{ message: string }> {}

let baseUrl = "";

const request = (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const base = HttpClientRequest.make(method)(`${baseUrl}${path}`);
    const response = yield* client.execute(
      body === undefined
        ? base
        : typeof body === "string"
          ? base.pipe(HttpClientRequest.bodyText(body))
          : base.pipe(HttpClientRequest.bodyJsonUnsafe(body)),
    );
    return { status: response.status, headers: response.headers, text: yield* response.text };
  });

const json = <T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) =>
  request(method, path, body).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? Effect.succeed(JSON.parse(response.text) as T)
        : Effect.fail(new NotReady({ message: `${path}: ${response.status} ${response.text}` })),
    ),
  );

/** Poll an observation the Worker records asynchronously (queues, cron, tails). */
const observed = <T>(key: string, times = 30) =>
  json<T | null>("GET", `/observe/${encodeURIComponent(key)}`).pipe(
    Effect.flatMap((value) =>
      value === null
        ? Effect.fail(new NotReady({ message: `${key} not observed yet` }))
        : Effect.succeed(value),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times }),
  );

describe.skipIf(!!process.env.FAST)(
  "celld native features",
  { tags: ["provider:celld", "provider:aws", "provider:aws:ecs", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const { url } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const app = yield* Celld.Application("FeaturesApp", {
              entrypoint: FeatureApi,
              workers: [FeatureService],
            });
            return { url: app.url };
          }).pipe(
            Effect.provide(
              Layer.mergeAll(FeatureApiLive, FeatureServiceLive).pipe(
                Layer.provideMerge(Celld.Fleet.layer(FeatureCells)),
              ),
            ),
          ),
        );
        baseUrl = String(url).replace(/\/+$/, "");
        yield* Effect.logInfo(`celld features: ${baseUrl}`);
        // The load balancer registers the node tasks after activation.
        yield* json("GET", "/health").pipe(
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
        );
      }),
      { timeout: 1_200_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
      timeout: 1_800_000,
    });

    test(
      "serves the Application entrypoint through the fleet's public ingress",
      Effect.gen(function* () {
        expect(baseUrl).toMatch(/^http:\/\/.+\.elb\.amazonaws\.com$/);
        expect(yield* json("GET", "/health")).toEqual({ runtime: "celld" });
      }),
    );

    test(
      "KV writes, reads metadata, lists and deletes",
      Effect.gen(function* () {
        yield* request("PUT", "/kv/greeting", "hello");
        expect(yield* json("GET", "/kv/greeting")).toEqual({
          value: "hello",
          metadata: { version: 1 },
        });
        const page = yield* json<{ keys: { name: string }[] }>("GET", "/kv/?prefix=greet");
        expect(page.keys.map((key) => key.name)).toEqual(["greeting"]);
        yield* request("DELETE", "/kv/greeting");
        expect(yield* json<{ value: unknown }>("GET", "/kv/greeting")).toMatchObject({
          value: null,
        });
      }),
    );

    test(
      "D1 applies deploy-time migrations and runs statements",
      Effect.gen(function* () {
        yield* request("POST", "/d1/a", "first");
        const result = yield* json<{ results: { id: string; value: string }[] }>("GET", "/d1");
        expect(result.results).toContainEqual({ id: "a", value: "first" });
      }),
    );

    test(
      "R2 stores objects with custom metadata in the fleet bucket",
      Effect.gen(function* () {
        yield* request("PUT", "/r2/notes.txt", "stored");
        expect(yield* json("GET", "/r2/notes.txt")).toEqual({
          text: "stored",
          customMetadata: { author: "alchemy" },
        });
        expect(yield* json<string[]>("GET", "/r2")).toContain("notes.txt");
        yield* request("DELETE", "/r2/notes.txt");
        expect((yield* request("GET", "/r2/notes.txt")).status).toBe(404);
      }),
    );

    test(
      "a SQLite Durable Object migrates on activation and keeps KV state",
      Effect.gen(function* () {
        yield* json("POST", "/notes/lobby", "one");
        const notes = yield* json<{ history: string[]; values: string[]; count: number }>(
          "POST",
          "/notes/lobby",
          "two",
        );
        expect(notes.history).toEqual(["0001_items.sql"]);
        expect(notes.values).toEqual(["one", "two"]);
        expect(notes.count).toBe(2);
      }),
    );

    test(
      "queues deliver, retry once, and dead-letter exhausted messages",
      Effect.gen(function* () {
        yield* request("POST", "/queue/send", [{ id: "plain" }]);
        yield* request("POST", "/queue/batch", [
          { id: "retried", mode: "retry" },
          { id: "dead", mode: "dead" },
        ]);
        expect(yield* observed<{ attempts: number }>("queue:plain")).toMatchObject({
          attempts: 1,
        });
        expect(yield* observed<{ attempts: number }>("queue:retried")).toMatchObject({
          attempts: 2,
        });
        expect(yield* observed<{ body: { id: string } }>("dead:dead")).toMatchObject({
          body: { id: "dead" },
        });
      }),
      { timeout: 180_000 },
    );

    test(
      "workflows run durable tasks and wait for events",
      Effect.gen(function* () {
        const runId = `wf-${Date.now().toString(36)}`;
        yield* json("POST", "/workflow/create", { id: runId, wait: true });
        yield* json<{ status: string }>("GET", `/workflow/status/${runId}`).pipe(
          Effect.filterOrFail(
            (status) => status.status === "waiting",
            (status) => new NotReady({ message: `workflow is ${status.status}` }),
          ),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }),
        );
        yield* json("POST", `/workflow/event/${runId}`);
        const done = yield* json<{ status: string; output: unknown }>(
          "GET",
          `/workflow/status/${runId}`,
        ).pipe(
          Effect.filterOrFail(
            (status) => status.status === "complete",
            (status) => new NotReady({ message: `workflow is ${status.status}` }),
          ),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }),
        );
        expect(done.output).toEqual({ id: runId, attempt: 1, approved: true });
      }),
      { timeout: 180_000 },
    );

    test(
      "cron triggers fire on the Application entrypoint",
      Effect.gen(function* () {
        const fired = yield* observed<{ cron: string }>("cron:last", 45);
        expect(fired.cron).toBe("* * * * *");
      }),
      { timeout: 180_000 },
    );

    test(
      "service bindings reach a secondary Worker in the same Application",
      Effect.gen(function* () {
        const response = yield* request("POST", "/service/echo", "ping");
        expect(response.status).toBe(200);
        expect(JSON.parse(response.text)).toMatchObject({
          service: "feature-service",
          method: "POST",
          body: "ping",
        });
      }),
    );

    test(
      "WorkerLoader runs loaded code, entrypoints and memoized named code",
      Effect.gen(function* () {
        for (const action of ["load", "named"]) {
          expect(yield* json("GET", `/loader/${action}`)).toEqual({
            body: { loaded: true, marker: "feature-loader" },
            sum: 9,
          });
        }
      }),
    );

    test(
      "loaded code reports tail events to the service Worker",
      Effect.gen(function* () {
        yield* json("GET", "/loader/load?id=tailed");
        const tail = yield* observed<{ event: { request: { url: string } } }>("tail:tailed");
        expect(tail.event.request.url).toContain("id=tailed");
      }),
      { timeout: 120_000 },
    );

    test(
      "static assets serve with _headers and _redirects",
      Effect.gen(function* () {
        const asset = yield* request("GET", "/hello.txt");
        expect(asset.status).toBe(200);
        expect(asset.text).toContain("Celld native asset fixture.");
        expect(asset.headers["x-native-asset"]).toBe("yes");
        // `/old` redirects to `/hello.txt`; the client follows it.
        const redirected = yield* request("GET", "/old");
        expect(redirected.status).toBe(200);
        expect(redirected.text).toContain("Celld native asset fixture.");
      }),
    );
  },
);
