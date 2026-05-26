import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/do-rpc/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "durable object methods can use binding clients",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const res = yield* client.post(`${url}/roundtrip`).pipe(
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

    expect(res.status).toBe(200);
    const body = (yield* res.json) as { value: string };
    expect(body.value).toBe("ok");
  }).pipe(logLevel),
  { timeout: 180_000 },
);

const fetchReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((r) =>
        r.status === 200
          ? Effect.succeed(r)
          : Effect.fail(new Error(`Worker not ready: ${r.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 15,
      }),
    );
    return yield* res.text;
  });

// Walk an async worker through four redeploys against the same scratch state,
// each one swapping in a new script + bindings shape so we exercise the
// migration paths `putWorker` relies on:
//   v1 — create with a single DO class `DO_A`
//   v2 — rename `DO_A` → `DO_A_v2` (className change, same binding id)
//   v3 — add a brand-new DO class `DO_B` alongside `DO_A_v2`
//   v4 — delete `DO_A`, keep only `DO_B`
test.provider(
  "durable object class migrations across redeploys",
  (scratch) =>
    Effect.gen(function* () {
      const v1 = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("worker", {
              script: `import { DurableObject } from "cloudflare:workers";
export class DO_A extends DurableObject {}
export default { async fetch() { return new Response("v1"); } };
`,
              bindings: {
                DO_A: Cloudflare.DurableObjectNamespace("DO_A"),
              },
            }),
          };
        }),
      );
      expect(yield* fetchReady(v1.worker.url!)).toBe("v1");

      const v2 = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("worker", {
              script: `import { DurableObject } from "cloudflare:workers";
export class DO_A_v2 extends DurableObject {}
export default { async fetch() { return new Response("v2"); } };
`,
              bindings: {
                DO_A: Cloudflare.DurableObjectNamespace("DO_A", {
                  className: "DO_A_v2",
                }),
              },
            }),
          };
        }),
      );
      expect(yield* fetchReady(v2.worker.url!)).toBe("v2");

      const v3 = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("worker", {
              script: `import { DurableObject } from "cloudflare:workers";
export class DO_A_v2 extends DurableObject {}
export class DO_B extends DurableObject {}
export default { async fetch() { return new Response("v3"); } };
`,
              bindings: {
                DO_A: Cloudflare.DurableObjectNamespace("DO_A", {
                  className: "DO_A_v2",
                }),
                DO_B: Cloudflare.DurableObjectNamespace("DO_B"),
              },
            }),
          };
        }),
      );
      expect(yield* fetchReady(v3.worker.url!)).toBe("v3");

      const v4 = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("worker", {
              script: `import { DurableObject } from "cloudflare:workers";
export class DO_B extends DurableObject {}
export default { async fetch() { return new Response("v4"); } };
`,
              bindings: {
                DO_B: Cloudflare.DurableObjectNamespace("DO_B"),
              },
            }),
          };
        }),
      );
      expect(yield* fetchReady(v4.worker.url!)).toBe("v4");

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);
