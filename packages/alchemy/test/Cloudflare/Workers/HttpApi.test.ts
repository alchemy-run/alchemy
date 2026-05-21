import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { TaskApi } from "./fixtures/http-api/api.ts";
import HttpApiTestWorker from "./fixtures/http-api/worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "HttpApiTestStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* HttpApiTestWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const testTimeout = 30_000;
const requestTimeout = "5 seconds";
const readinessRetry = {
  schedule: Schedule.exponential("250 millis"),
  times: 6,
} as const;

const makeClient = (url: string) =>
  HttpApiClient.make(TaskApi, { baseUrl: url });

test(
  "deployed http-api worker handles createTask + getTask via typed HttpApiClient",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeTypeOf("string");
    const client = yield* makeClient(url);

    const created = yield* client.Tasks.createTask({
      payload: { title: "Write docs" },
    }).pipe(Effect.timeout(requestTimeout), Effect.retry(readinessRetry));
    expect(created.title).toBe("Write docs");
    expect(created.completed).toBe(false);
    expect(created.id).toBeTypeOf("string");

    const fetched = yield* client.Tasks.getTask({ params: { id: created.id } });
    expect(fetched.id).toBe(created.id);
    expect(fetched.title).toBe("Write docs");

    const missing = yield* client.Tasks.getTask({
      params: { id: "does-not-exist" },
    }).pipe(Effect.flip);
    expect(missing._tag).toBe("TaskNotFound");
    if (missing._tag === "TaskNotFound") {
      expect(missing.id).toBe("does-not-exist");
    }
  }).pipe(logLevel),
  { timeout: testTimeout },
);

test(
  "cors middleware adds Access-Control-Allow-Origin header on preflight",
  Effect.gen(function* () {
    const { url } = yield* stack;
    // CORS preflight (OPTIONS) is transport-level and not part of the typed
    // HttpApi surface, so this single check uses the raw HttpClient.
    const client = yield* HttpClient.HttpClient;

    const res = yield* client
      .execute(
        HttpClientRequest.make("OPTIONS")(url).pipe(
          HttpClientRequest.setHeaders({
            Origin: "https://example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
          }),
        ),
      )
      .pipe(Effect.timeout(requestTimeout), Effect.retry(readinessRetry));
    expect(res.headers["access-control-allow-origin"]).toBeDefined();
  }).pipe(logLevel),
  { timeout: testTimeout },
);

test(
  "concurrent createTask survives scope-lifecycle pressure",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* makeClient(url);

    yield* client.Tasks.createTask({ payload: { title: "warmup" } }).pipe(
      Effect.timeout(requestTimeout),
      Effect.retry(readinessRetry),
    );

    const N = 200;
    const results = yield* Effect.forEach(
      Array.from({ length: N }, (_, i) => i),
      (i) =>
        Effect.gen(function* () {
          const created = yield* client.Tasks.createTask({
            payload: { title: `task-${i}` },
          }).pipe(Effect.timeout(requestTimeout));
          if (created.title !== `task-${i}`) {
            return yield* Effect.fail(
              new Error(`create ${i} title mismatch: ${created.title}`),
            );
          }
          return created.id;
        }),
      { concurrency: 64 },
    );

    expect(results).toHaveLength(N);
    expect(new Set(results).size).toBe(N);
  }).pipe(logLevel),
  { timeout: testTimeout },
);

test(
  "createTaskDO + getTaskDO round-trip 100x in parallel through the DO HttpApi",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* makeClient(url);

    yield* client.Tasks.createTaskDO({ payload: { title: "warmup" } }).pipe(
      Effect.timeout(requestTimeout),
      Effect.retry(readinessRetry),
    );

    const N = 100;
    yield* Effect.forEach(
      Array.from({ length: N }, (_, i) => i),
      (i) =>
        Effect.gen(function* () {
          const title = `do-task-${i}`;
          const created = yield* client.Tasks.createTaskDO({
            payload: { title },
          }).pipe(Effect.timeout(requestTimeout));
          expect(created.title).toBe(title);
          expect(created.completed).toBe(false);
          expect(created.id).toBeTypeOf("string");

          const fetched = yield* client.Tasks.getTaskDO({
            params: { id: created.id },
          }).pipe(Effect.timeout(requestTimeout));
          expect(fetched.id).toBe(created.id);
          expect(fetched.title).toBe(title);
        }),
      { concurrency: 32 },
    );
  }).pipe(logLevel),
  { timeout: testTimeout },
);
