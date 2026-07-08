import * as Cloudflare from "@/Cloudflare";
import {
  DEFAULT_REQUEST_ID,
  type TestLogRow,
} from "@/Cloudflare/Workers/TestLogging/constants.ts";
import {
  getTestLoggerTargets,
  type TestLoggerTarget,
} from "@/Cloudflare/Workers/TestLogging/Registry.ts";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import Stack from "./fixtures/test-logging/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const testTimeout = 120_000;
const requestTimeout = "5 seconds";
// Fresh `*.workers.dev` URLs propagate through the edge over a few seconds —
// force retries on non-2xx statuses until the script is resolvable.
const readinessRetry = {
  schedule: Schedule.exponential("500 millis").pipe(
    Schedule.either(Schedule.spaced("3 seconds")),
  ),
  times: 15,
} as const;

const requestUntilReady = (
  effect: Effect.Effect<HttpClientResponse, unknown, never>,
) =>
  effect.pipe(
    Effect.timeout(requestTimeout),
    Effect.flatMap(
      Effect.fn(function* (res) {
        return res.status >= 200 && res.status < 300
          ? res
          : yield* Effect.fail(
              new Error(`Worker not ready: ${res.status} ${yield* res.text}`),
            );
      }),
    ),
    Effect.retry(readinessRetry),
  );

/** The logger target the deploy registered for this stack's DO instance. */
const loggerTarget = (): TestLoggerTarget => {
  const target = getTestLoggerTargets().find(
    (t) => t.doName === "TestLoggingStack/test",
  );
  if (target === undefined) {
    throw new Error(
      "No test-logger target registered for TestLoggingStack/test — did the deploy provision alchemy-test-logger?",
    );
  }
  return target;
};

/** Delete-and-return buffered rows for `requestId` from the logger DO. */
const flushRows = (target: TestLoggerTarget, requestId: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* requestUntilReady(
      client.get(
        `${target.loggerUrl}/__alchemy/flush?do=${encodeURIComponent(
          target.doName,
        )}&requestId=${encodeURIComponent(requestId)}`,
      ),
    );
    return (yield* response.json) as unknown as TestLogRow[];
  });

/**
 * Poll the logger DO until a row matching `predicate` shows up (log delivery
 * goes through `waitUntil`, so rows can trail the response by a beat).
 * Accumulates across polls since each flush deletes what it returns.
 */
const collectRows = (
  target: TestLoggerTarget,
  requestId: string,
  predicate: (row: TestLogRow) => boolean,
) =>
  Effect.gen(function* () {
    const acc: TestLogRow[] = [];
    yield* flushRows(target, requestId).pipe(
      Effect.map((rows) => {
        acc.push(...rows);
        return acc;
      }),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (rows) => rows.some(predicate),
        times: 20,
      }),
    );
    return acc;
  });

test(
  "Effect-native worker logs are correlated to the test's request ID",
  Effect.gen(function* () {
    const { effectUrl, effectName } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const marker = "effect-marker";

    const res = yield* requestUntilReady(
      client.get(`${effectUrl}/?marker=${marker}`),
    );
    const body = (yield* res.json) as { requestId: string | null };
    // The harness injected a unique `alchemy-request-id` header for this test.
    expect(body.requestId).toBeTruthy();
    const requestId = body.requestId!;

    const rows = yield* collectRows(loggerTarget(), requestId, (row) =>
      row.message.includes(marker),
    );

    const logRow = rows.find(
      (row) => row.method === "log" && row.message.includes(marker),
    );
    expect(logRow).toBeDefined();
    expect(logRow!.message).toBe(`effect-log ${marker}`);
    expect(logRow!.workerName).toBe(effectName);
    expect(logRow!.requestId).toBe(requestId);

    const warnRow = rows.find(
      (row) => row.method === "warn" && row.message.includes(marker),
    );
    expect(warnRow).toBeDefined();
    expect(warnRow!.message).toBe(`effect-warn ${marker}`);
  }),
  { timeout: testTimeout },
);

test(
  "external (non-Effect) worker logs are correlated via the wrapper entry",
  Effect.gen(function* () {
    const { asyncUrl, asyncName } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const marker = "async-marker";

    const res = yield* requestUntilReady(
      client.get(`${asyncUrl}/?marker=${marker}`),
    );
    const body = (yield* res.json) as { requestId: string | null };
    expect(body.requestId).toBeTruthy();
    const requestId = body.requestId!;

    const rows = yield* collectRows(loggerTarget(), requestId, (row) =>
      row.message.includes(marker),
    );

    const logRow = rows.find(
      (row) => row.method === "log" && row.message.includes(marker),
    );
    expect(logRow).toBeDefined();
    expect(logRow!.message).toBe(`async-log ${marker}`);
    expect(logRow!.workerName).toBe(asyncName);
    expect(logRow!.requestId).toBe(requestId);

    const errorRow = rows.find(
      (row) => row.method === "error" && row.message.includes(marker),
    );
    expect(errorRow).toBeDefined();
    expect(errorRow!.message).toBe(`async-error ${marker}`);
  }),
  { timeout: testTimeout },
);

test(
  "requests without the header land in the unattributed default bucket",
  Effect.gen(function* () {
    const { asyncUrl } = yield* stack;
    const marker = "unattributed-marker";

    // A pristine HttpClient (no harness-injected `alchemy-request-id`
    // header) — like a queue/scheduled handler or an out-of-band request.
    yield* Effect.gen(function* () {
      const raw = yield* HttpClient.HttpClient;
      const res = yield* requestUntilReady(
        raw.get(`${asyncUrl}/?marker=${marker}`),
      );
      const body = (yield* res.json) as { requestId: string | null };
      expect(body.requestId).toBeNull();
    }).pipe(Effect.provide(FetchHttpClient.layer));

    const rows = yield* collectRows(loggerTarget(), DEFAULT_REQUEST_ID, (row) =>
      row.message.includes(marker),
    );
    const logRow = rows.find(
      (row) => row.method === "log" && row.message.includes(marker),
    );
    expect(logRow).toBeDefined();
    expect(logRow!.requestId).toBe(DEFAULT_REQUEST_ID);
  }),
  { timeout: testTimeout },
);
