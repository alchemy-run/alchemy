import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { TaskApi } from "./fixtures/http-api/api.ts";
import Stack from "./fixtures/http-api/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const testTimeout = 15_000;
const burstTimeout = 30_000;
const requestTimeout = "5 seconds";
const readinessRetry = {
  schedule: Schedule.exponential("250 millis"),
  times: 6,
} as const;

const makeClient = (url: string) =>
  HttpApiClient.make(TaskApi, { baseUrl: url });

// Gate the deploy on the worker having propagated to the edge: hit both the
// R2-backed (`createTask`) and DO-backed (`createTaskDO`) paths once, retrying
// through the freshly-deployed 404 window, then give it extra time to settle
// across edge PoPs. Individual tests can then call the API directly without
// each re-implementing a per-request readiness retry.
const stack = beforeAll(
  deploy(Stack).pipe(
    Effect.tap(({ url }) =>
      Effect.gen(function* () {
        const client = yield* makeClient(url);
        yield* client.Tasks.createTask({ payload: { title: "warmup" } }).pipe(
          Effect.timeout(requestTimeout),
          Effect.retry(readinessRetry),
        );
        yield* client.Tasks.createTaskDO({ payload: { title: "warmup" } }).pipe(
          Effect.timeout(requestTimeout),
          Effect.retry(readinessRetry),
        );
      }),
    ),
    // just give it some extra time to propagate
    Effect.tap(Effect.sleep("5 seconds")),
  ),
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "deployed http-api worker handles createTask + getTask via typed HttpApiClient",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeTypeOf("string");
    const client = yield* makeClient(url);

    const created = yield* client.Tasks.createTask({
      payload: { title: "Write docs" },
    }).pipe(Effect.timeout(requestTimeout));
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
      .pipe(Effect.timeout(requestTimeout));
    expect(res.headers["access-control-allow-origin"]).toBeDefined();
  }).pipe(logLevel),
  { timeout: testTimeout },
);

test(
  "cors middleware adds Access-Control-Allow-Origin header on actual requests",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const res = yield* client
      .execute(
        HttpClientRequest.post(`${url}/`).pipe(
          HttpClientRequest.setHeaders({ Origin: "https://example.com" }),
          HttpClientRequest.bodyJsonUnsafe({ title: "cors-check" }),
        ),
      )
      .pipe(Effect.timeout(requestTimeout));
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeDefined();
  }).pipe(logLevel),
  { timeout: testTimeout },
);

test(
  "concurrent createTask survives scope-lifecycle pressure",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* makeClient(url);

    const N = 200;
    const results = yield* Effect.forEach(
      Array.from({ length: N }, (_, i) => i),
      (i) =>
        Effect.gen(function* () {
          const created = yield* client.Tasks.createTask({
            payload: { title: `task-${i}` },
          }).pipe(Effect.timeout(requestTimeout), Effect.retry(readinessRetry));
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
  { timeout: burstTimeout },
);

test(
  "createTaskDO + getTaskDO round-trip 100x in parallel through the DO HttpApi",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* makeClient(url);

    const N = 100;
    yield* Effect.forEach(
      Array.from({ length: N }, (_, i) => i),
      (i) =>
        Effect.gen(function* () {
          const title = `do-task-${i}`;
          const created = yield* client.Tasks.createTaskDO({
            payload: { title },
          }).pipe(Effect.timeout(requestTimeout), Effect.retry(readinessRetry));
          expect(created.title).toBe(title);
          expect(created.completed).toBe(false);
          expect(created.id).toBeTypeOf("string");

          const fetched = yield* client.Tasks.getTaskDO({
            params: { id: created.id },
          }).pipe(Effect.timeout(requestTimeout), Effect.retry(readinessRetry));
          expect(fetched.id).toBe(created.id);
          expect(fetched.title).toBe(title);
        }),
      { concurrency: 32 },
    );
  }).pipe(logLevel),
  { timeout: burstTimeout },
);
