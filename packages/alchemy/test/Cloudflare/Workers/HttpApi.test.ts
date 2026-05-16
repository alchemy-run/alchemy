import * as Alchemy from "@/index.ts";
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

test(
  "deployed http-api worker handles createTask + getTask via HttpClient",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeTypeOf("string");
    const client = yield* HttpClient.HttpClient;

    const created = yield* client
      .execute(
        HttpClientRequest.post(`${url}/`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ title: "Write docs" }),
        ),
      )
      .pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 15,
        }),
      );
    const createdBody = (yield* created.json) as {
      id: string;
      title: string;
      completed: boolean;
    };
    expect(createdBody.title).toBe("Write docs");
    expect(createdBody.completed).toBe(false);
    expect(createdBody.id).toBeTypeOf("string");

    const fetched = yield* client.get(`${url}/${createdBody.id}`);
    expect(fetched.status).toBe(200);
    const fetchedBody = (yield* fetched.json) as { id: string; title: string };
    expect(fetchedBody.id).toBe(createdBody.id);
    expect(fetchedBody.title).toBe("Write docs");

    const missing = yield* client.get(`${url}/does-not-exist`);
    expect(missing.status).toBe(404);
    const missingBody = (yield* missing.json) as {
      _tag: string;
      id: string;
    };
    expect(missingBody._tag).toBe("TaskNotFound");
    expect(missingBody.id).toBe("does-not-exist");
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "cors middleware adds Access-Control-Allow-Origin header on preflight",
  Effect.gen(function* () {
    const { url } = yield* stack;
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
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
    expect(res.headers["access-control-allow-origin"]).toBeDefined();
  }).pipe(logLevel),
  { timeout: 60_000 },
);

test(
  "concurrent createTask + getTask survive scope-lifecycle pressure",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    yield* client
      .execute(
        HttpClientRequest.post(`${url}/`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ title: "warmup" }),
        ),
      )
      .pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : Effect.fail(new Error(`warmup not ready: ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 15,
        }),
      );

    const N = 200;
    const results = yield* Effect.forEach(
      Array.from({ length: N }, (_, i) => i),
      (i) =>
        Effect.gen(function* () {
          const created = yield* client
            .execute(
              HttpClientRequest.post(`${url}/`).pipe(
                HttpClientRequest.bodyJsonUnsafe({ title: `task-${i}` }),
              ),
            )
            .pipe(Effect.timeout("15 seconds"));
          if (created.status !== 200) {
            return yield* Effect.fail(
              new Error(`create ${i} -> ${created.status}`),
            );
          }
          const body = (yield* created.json) as { id: string; title: string };
          if (body.title !== `task-${i}`) {
            return yield* Effect.fail(
              new Error(`create ${i} title mismatch: ${body.title}`),
            );
          }
          return body.id;
        }),
      { concurrency: 64 },
    );

    expect(results).toHaveLength(N);
    expect(new Set(results).size).toBe(N);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "deployed http-api worker is consumable via typed HttpApiClient",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const client = yield* HttpApiClient.make(TaskApi, { baseUrl: url });

    const created = yield* client.Tasks.createTask({
      payload: { title: "Typed client task" },
    }).pipe(
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 15,
      }),
    );
    expect(created.title).toBe("Typed client task");
    expect(created.completed).toBe(false);

    const fetched = yield* client.Tasks.getTask({
      params: { id: created.id },
    });
    expect(fetched.id).toBe(created.id);
    expect(fetched.title).toBe("Typed client task");
  }).pipe(logLevel),
  { timeout: 180_000 },
);
