import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/wait-until/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "waitUntil runs background Effects past the response (worker ctx + DO state)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    // Readiness probe through workers.dev propagation; also asserts the raw
    // escape hatch is the genuine workerd ExecutionContext.
    const raw = yield* Effect.gen(function* () {
      const res = yield* client.get(`${url}/raw`);
      if (res.status !== 200) {
        return yield* Effect.fail(new Error(`Worker not ready: ${res.status}`));
      }
      return yield* res.text;
    }).pipe(
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
    );
    expect(raw).toBe("ok");

    // Fire both background writes: one from the Worker's ExecutionContext,
    // one from inside the DO via DurableObjectState.waitUntil. Both routes
    // respond before the journal entry is persisted.
    const bg = yield* client
      .get(`${url}/bg`)
      .pipe(Effect.flatMap((res) => res.text));
    expect(bg).toBe("scheduled");
    const bgDo = yield* client
      .get(`${url}/bg-do`)
      .pipe(Effect.flatMap((res) => res.text));
    expect(bgDo).toBe("scheduled");

    // The entries only appear if waitUntil kept the invocations alive until
    // the delayed writes completed.
    const entries = yield* Effect.gen(function* () {
      const res = yield* client.get(`${url}/entries`);
      if (res.status !== 200) return [];
      const body = (yield* res.json) as { entries?: string[] };
      return body.entries ?? [];
    }).pipe(
      Effect.catch(() => Effect.succeed([] as string[])),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (entries) =>
          entries.includes("from-worker-wait-until") &&
          entries.includes("from-do-wait-until"),
        times: 30,
      }),
    );

    expect(entries).toContain("from-worker-wait-until");
    expect(entries).toContain("from-do-wait-until");
  }).pipe(logLevel),
  { timeout: 180_000 },
);
