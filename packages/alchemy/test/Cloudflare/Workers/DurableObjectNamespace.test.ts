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

// Cap exponential backoff at 3s — keeps the fast-path snappy but stops
// the geometric blow-up (0.5 + 1 + 2 + 4 + 8 + 16 + 32 + 64s ...) that
// makes retries dominate test wall time when CF edge is slow.
const readinessSchedule = Schedule.exponential("500 millis").pipe(
  Schedule.either(Schedule.spaced("3 seconds")),
);

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
      Effect.retry({ schedule: readinessSchedule, times: 15 }),
    );

    expect(res.status).toBe(200);
    const body = (yield* res.json) as { value: string };
    expect(body.value).toBe("ok");
  }).pipe(logLevel),
  { timeout: 180_000 },
);

// Cloudflare's edge keeps serving the previous worker version for a few
// seconds after a redeploy, so retrying on 200-only is not enough — the
// stale version still returns 200 with the old body. Retry until the
// body matches the expected version string.
const fetchReady = (url: string, expected: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((r) =>
        r.status === 200
          ? Effect.flatMap(r.text, (body) =>
              body === expected
                ? Effect.succeed(body)
                : Effect.fail(
                    new Error(`stale: got ${body}, want ${expected}`),
                  ),
            )
          : Effect.fail(new Error(`Worker not ready: ${r.status}`)),
      ),
      Effect.retry({ schedule: readinessSchedule, times: 15 }),
    );
  });

const fetchJsonReady = <T>(url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((r) =>
        r.status === 200
          ? Effect.succeed(r)
          : Effect.fail(new Error(`Worker not ready: ${r.status}`)),
      ),
      Effect.retry({ schedule: readinessSchedule, times: 15 }),
    );
    return (yield* res.json) as T;
  });

const hostWorkerScript = `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async increment() {
    const value = (await this.ctx.storage.get("count")) ?? 0;
    const next = value + 1;
    await this.ctx.storage.put("count", next);
    return next;
  }
  async reset() {
    await this.ctx.storage.delete("count");
  }
  async get() {
    return (await this.ctx.storage.get("count")) ?? 0;
  }
}
export default {
  async fetch(request, env) {
    const stub = env.Counter.getByName("shared");
    const url = new URL(request.url);
    if (url.pathname === "/increment") {
      return Response.json({ value: await stub.increment() });
    }
    if (url.pathname === "/get") {
      return Response.json({ value: await stub.get() });
    }
    if (url.pathname === "/reset") {
      await stub.reset();
      return Response.json({ ok: true });
    }
    return new Response("Not Found", { status: 404 });
  },
};
`;

const consumerWorkerScript = `export default {
  async fetch(request, env) {
    const stub = env.Counter.getByName("shared");
    const url = new URL(request.url);
    if (url.pathname === "/increment") {
      return Response.json({ value: await stub.increment() });
    }
    if (url.pathname === "/get") {
      return Response.json({ value: await stub.get() });
    }
    if (url.pathname === "/reset") {
      await stub.reset();
      return Response.json({ ok: true });
    }
    return new Response("Not Found", { status: 404 });
  },
};
`;

test.provider(
  "async worker durable object binding accepts scriptName",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            host: yield* Cloudflare.Worker("host-worker", {
              script: hostWorkerScript,
              bindings: {
                Counter: Cloudflare.DurableObjectNamespace("Counter"),
              },
            }),
          };
        }),
      );

      const deployed = yield* scratch.deploy(
        Effect.gen(function* () {
          const host = yield* Cloudflare.Worker("host-worker", {
            script: hostWorkerScript,
            bindings: {
              Counter: Cloudflare.DurableObjectNamespace("Counter"),
            },
          });
          const consumer = yield* Cloudflare.Worker("consumer-worker", {
            script: consumerWorkerScript,
            bindings: {
              Counter: Cloudflare.DurableObjectNamespace("Counter", {
                scriptName: host.workerName,
              }),
            },
          });

          return { consumer, host };
        }),
      );

      const reset = yield* fetchJsonReady<{ ok: boolean }>(
        `${deployed.host.url}/reset`,
      );
      expect(reset.ok).toBe(true);

      const first = yield* fetchJsonReady<{ value: number }>(
        `${deployed.consumer.url}/increment`,
      );
      expect(first.value).toBe(1);

      const second = yield* fetchJsonReady<{ value: number }>(
        `${deployed.host.url}/get`,
      );
      expect(second.value).toBe(1);

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

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
      expect(yield* fetchReady(v1.worker.url!, "v1")).toBe("v1");

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
      expect(yield* fetchReady(v2.worker.url!, "v2")).toBe("v2");

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
      expect(yield* fetchReady(v3.worker.url!, "v3")).toBe("v3");

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
      expect(yield* fetchReady(v4.worker.url!, "v4")).toBe("v4");

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);
