import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/stack.ts";

// The fixture stack provisions its own Flagship app via the FlagshipApp
// resource and binds it to both workers. Each fixture worker evaluates a
// flag and returns the result; with no matching flag configured, Flagship
// falls back to the provided defaults, so the assertions below hold whether
// or not the app has flags defined.
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

// Cloudflare's edge takes a few seconds to start serving a fresh workers.dev
// URL — retry through the transient propagation states until the worker
// answers 200.
const looksLikeCloudflarePlaceholder = (body: string) =>
  body.includes("There is nothing here yet") || /Error\s+\d{3,4}/i.test(body);

const getJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? res.json
        : res.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new WorkerNotReady({ status: res.status, body })),
            ),
          ),
    ),
    Effect.retry({
      while: (e): e is WorkerNotReady =>
        e instanceof WorkerNotReady &&
        ((e.status >= 400 && e.status < 500) ||
          looksLikeCloudflarePlaceholder(e.body)),
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.either(Schedule.spaced("5 seconds")),
        Schedule.both(Schedule.recurs(30)),
      ),
    }),
  );

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "async worker evaluates a boolean flag via env Flagship binding",
  Effect.gen(function* () {
    const { asyncWorkerUrl } = yield* stack;
    const result = yield* getJson(`${asyncWorkerUrl}/bool`);
    expect(result).toMatchObject({ mode: "async", enabled: false });
  }),
  { timeout: 240_000 },
);

test(
  "async worker returns fallback details for a nonexistent flag",
  Effect.gen(function* () {
    const { asyncWorkerUrl } = yield* stack;
    const result = (yield* getJson(`${asyncWorkerUrl}/details`)) as {
      mode: string;
      details: { flagKey: string; value: string };
    };
    expect(result.mode).toBe("async");
    expect(result.details.flagKey).toBe("nonexistent-flag");
    expect(result.details.value).toBe("fallback");
  }),
  { timeout: 240_000 },
);

test(
  "effect worker evaluates a boolean flag via FlagshipApp.bind",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    const result = yield* getJson(`${effectWorkerUrl}/bool`);
    expect(result).toMatchObject({ mode: "effect", enabled: false });
  }),
  { timeout: 240_000 },
);

test(
  "effect worker returns fallback details for a nonexistent flag",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    const result = (yield* getJson(`${effectWorkerUrl}/details`)) as {
      mode: string;
      details: { flagKey: string; value: string };
    };
    expect(result.mode).toBe("effect");
    expect(result.details.flagKey).toBe("nonexistent-flag");
    expect(result.details.value).toBe("fallback");
  }),
  { timeout: 240_000 },
);
