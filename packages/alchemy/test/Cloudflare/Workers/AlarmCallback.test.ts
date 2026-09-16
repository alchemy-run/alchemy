import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type {
  RollbackResult,
  Snapshot,
} from "./fixtures/alarm-callback/object.ts";
import Stack from "./fixtures/alarm-callback/stack.ts";

const requestJson = <T>(url: string, method: "GET" | "POST") =>
  Effect.gen(function* () {
    const client = HttpClient.mapRequest(
      yield* HttpClient.HttpClient,
      HttpClientRequest.setHeaders({
        connection: "close",
        "cache-control": "no-cache",
      }),
    );
    const fresh = new URL(url);
    fresh.searchParams.set("cb", yield* Effect.sync(() => String(Date.now())));
    const response = yield* method === "POST"
      ? client.post(fresh.href)
      : client.get(fresh.href);
    const body = yield* response.text;
    if (response.status !== 200) {
      const message = `${method} ${url}: HTTP ${response.status}: ${body}`;
      if (
        response.status === 404 ||
        (response.status >= 500 &&
          (method === "GET" || body.includes("<title>Script not found |")))
      ) {
        return yield* Effect.fail(
          Object.assign(new Test.WorkerNotReady({ status: response.status }), {
            message,
            body,
            url,
          }),
        );
      }
      return yield* Effect.fail(new Error(message));
    }
    return yield* Effect.try({
      try: () => JSON.parse(body) as T,
      catch: () => new Error(`${method} ${url}: Invalid JSON: ${body}`),
    });
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.retry({
      while: (error) => error instanceof Test.WorkerNotReady,
      schedule: Schedule.spaced("2 seconds"),
      times: 8,
    }),
  );

const json = <T>(url: string, method: "GET" | "POST" = "GET") =>
  Effect.gen(function* () {
    if (method === "POST") {
      const snapshot = new URL(url);
      snapshot.pathname = snapshot.pathname.replace(
        /\/[^/]+$/,
        snapshot.pathname.endsWith("/legacy") ? "/legacy" : "/snapshot",
      );
      snapshot.search = "";
      yield* requestJson(snapshot.href, "GET");
    }
    return yield* requestJson<T>(url, method);
  });

const poll = <T>(
  url: string,
  until: (value: T) => boolean,
  interval: "2 seconds" | "4 seconds" = "2 seconds",
) =>
  json<T>(url).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(interval),
      until,
      times: 10,
    }),
    Effect.flatMap((snapshot) =>
      until(snapshot)
        ? Effect.succeed(snapshot)
        : Effect.fail(
            new Error(
              `Alarm polling exhausted for ${url}: ${JSON.stringify(snapshot)}`,
            ),
          ),
    ),
  );

const deliveries = (snapshot: Snapshot) =>
  snapshot.deliveries
    .map(({ callback, value }) => `${callback}:${value}`)
    .sort();

const drained = (count: number) => (snapshot: Snapshot) =>
  snapshot.deliveries.length === count && snapshot.alarm === null;

const assertRollback = (snapshot: Snapshot) => {
  expect(snapshot.application).toBeNull();
  expect(snapshot.cleanupWrite).toBeNull();
  expect(snapshot.rows).toEqual([]);
};

describe.concurrent.each([
  { dev: true, stage: "alarm-callback-local" },
  { dev: false, stage: "alarm-callback-live" },
])("makeAlarmCallback (dev: $dev)", ({ dev, stage }) => {
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
    dev,
    stage,
  });

  const stack = beforeAll(
    Effect.gen(function* () {
      yield* destroy(Stack);
      const output = yield* deploy(Stack);
      yield* json<Snapshot>(`${output.url}/readiness/snapshot`);
      yield* json(`${output.url}/readiness/legacy`);
      expect(output.url.startsWith("http://localhost:")).toBe(dev);
      return output;
    }),
    { timeout: 120_000 },
  );
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
    timeout: 30_000,
  });

  test(
    "native alarms deliver typed payloads, overwrite by callback and ID, and cancel",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const initial = yield* json<Snapshot>(`${url}/timing/timing`, "POST");
      expect(initial.alarm).not.toBeNull();
      const result = yield* poll<Snapshot>(
        `${url}/timing/snapshot`,
        drained(5),
      );
      expect(deliveries(result)).toEqual([
        "archive:checkpoint",
        "archive:date",
        "archive:duration",
        "archive:latest",
        "secondary:other-callback",
      ]);
      expect(result.alarm).toBeNull();
    }),
    { timeout: 90_000 },
  );

  test(
    "commits application SQL, KV, and a scheduled callback in one transaction",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const initial = yield* json<{
        marker: string;
        legacyOverload: string;
        snapshot: Snapshot;
      }>(`${url}/atomic/atomic`, "POST");
      expect(initial.marker).toBe("committed");
      expect(initial.legacyOverload).toBe("callback");
      expect(initial.snapshot.application).toBe("committed");
      expect(initial.snapshot.rows).toEqual([{ value: "committed" }]);
      expect(initial.snapshot.alarm).not.toBeNull();
      const result = yield* poll<Snapshot>(
        `${url}/atomic/snapshot`,
        drained(1),
      );
      expect(result.deliveries).toEqual([
        {
          callback: "archive",
          value: "committed",
          application: "committed",
          boots: result.boots,
        },
      ]);
      expect(result.alarm).toBeNull();
    }),
    { timeout: 90_000 },
  );

  for (const [kind, failure] of [
    ["typed", "typed-value"],
    ["defect", "defect"],
    ["interrupt", "interrupted"],
  ] as const) {
    test(
      `${kind} failure rolls back SQL, KV, scheduling, cancellation, and the native wake`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        const base = `${url}/rollback-${kind}`;
        const result = yield* json<RollbackResult>(
          `${base}/rollback-${kind}`,
          "POST",
        );
        expect(result.failure).toBe(failure);
        expect(result.cleanupWaited).toBe(true);
        expect(result.alarmBefore).not.toBeNull();
        expect(result.alarmAfter).toBe(result.alarmBefore);
        assertRollback(result.snapshot);
        const after = yield* poll<Snapshot>(`${base}/snapshot`, drained(2));
        assertRollback(after);
        expect(deliveries(after)).toEqual([
          "archive:checkpoint",
          "archive:kept",
        ]);
        expect(after.alarm).toBeNull();
      }),
      { timeout: 90_000 },
    );
  }

  test(
    "persists a recovery wake before a fallible handler and acknowledges only success",
    Effect.gen(function* () {
      const { url } = yield* stack;
      yield* json(`${url}/retry/retry`, "POST");
      const result = yield* poll<Snapshot>(`${url}/retry/snapshot`, drained(1));
      expect(deliveries(result)).toEqual(["retry:retried"]);
      expect(result.attempts).toHaveLength(2);
      for (const attempt of result.attempts) {
        expect(attempt.recovery).not.toBeNull();
        expect(attempt.recovery!).toBeGreaterThan(attempt.now);
      }
      expect(result.alarm).toBeNull();
    }),
    { timeout: 90_000 },
  );

  test(
    "acknowledging a callback does not delete its same-ID replacement",
    Effect.gen(function* () {
      const { url } = yield* stack;
      yield* json(`${url}/replacement/replace`, "POST");
      const result = yield* poll<Snapshot>(
        `${url}/replacement/snapshot`,
        drained(2),
      );
      expect(deliveries(result)).toEqual([
        "archive:replace-first",
        "archive:replace-second",
      ]);
      expect(result.alarm).toBeNull();
    }),
    { timeout: 90_000 },
  );

  test(
    "reconstructs instance-local registrations after abort without mixing object IDs",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const [first, second] = yield* Effect.all(
        [
          json<Snapshot>(`${url}/reset-first/reset?value=first`, "POST"),
          json<Snapshot>(`${url}/reset-second/reset?value=second`, "POST"),
        ],
        { concurrency: "unbounded" },
      );
      expect(first.id).not.toBe(second.id);
      const aborted = yield* json<{ aborted: boolean }>(
        `${url}/reset-first/abort`,
        "POST",
      );
      expect(aborted.aborted).toBe(true);
      const [afterFirst, afterSecond] = yield* Effect.all(
        [
          poll<Snapshot>(`${url}/reset-first/snapshot`, drained(1)),
          poll<Snapshot>(`${url}/reset-second/snapshot`, drained(1)),
        ],
        { concurrency: "unbounded" },
      );
      expect(afterFirst.id).toBe(first.id);
      expect(afterFirst.boots).toBeGreaterThan(first.boots);
      expect(afterFirst.deliveries[0]?.boots).toBe(afterFirst.boots);
      expect(deliveries(afterFirst)).toEqual(["archive:first"]);
      expect(deliveries(afterSecond)).toEqual(["archive:second"]);
      expect(afterFirst.alarm).toBeNull();
      expect(afterSecond.alarm).toBeNull();
    }),
    { timeout: 90_000 },
  );

  test(
    "recovers a callback after the handler aborts with native alarm retries disabled",
    Effect.gen(function* () {
      const { url } = yield* stack;
      yield* json(`${url}/recovery/recovery`, "POST");
      const result = yield* poll<Snapshot>(
        `${url}/recovery/snapshot`,
        drained(1),
        "4 seconds",
      );
      yield* Effect.logInfo("Alarm crash recovery snapshot", result);
      expect(deliveries(result)).toEqual(["crash:recovered"]);
      expect(result.pendingJobs).toEqual([]);
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[1]!.boots).toBeGreaterThan(
        result.attempts[0]!.boots,
      );
      for (const attempt of result.attempts) {
        expect(attempt.recovery).not.toBeNull();
        expect(attempt.recovery!).toBeGreaterThan(attempt.now);
      }
      expect(result.alarm).toBeNull();
    }),
    { timeout: 90_000 },
  );

  test(
    "retains an unknown callback until its registration is restored",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const initial = yield* json<Snapshot>(`${url}/unknown/optional`, "POST");
      expect(initial.alarm).not.toBeNull();
      expect(
        (yield* json<{ aborted: boolean }>(`${url}/unknown/abort`, "POST"))
          .aborted,
      ).toBe(true);
      const pending = yield* poll<Snapshot>(
        `${url}/unknown/snapshot`,
        (value) => value.alarm !== null && value.alarm > initial.alarm!,
      );
      expect(pending.boots).toBeGreaterThan(initial.boots);
      expect(pending.deliveries).toEqual([]);
      expect(pending.alarm).not.toBeNull();
      expect(pending.alarm!).toBeGreaterThan(initial.alarm!);
      yield* json(`${url}/unknown/enable-optional`, "POST");
      expect(
        (yield* json<{ aborted: boolean }>(`${url}/unknown/abort`, "POST"))
          .aborted,
      ).toBe(true);
      const restored = yield* poll<Snapshot>(
        `${url}/unknown/snapshot`,
        drained(1),
        "4 seconds",
      );
      expect(deliveries(restored)).toEqual(["optional:retained"]);
      expect(restored.boots).toBeGreaterThan(pending.boots);
      expect(restored.alarm).toBeNull();
    }),
    { timeout: 90_000 },
  );

  test(
    "drains a backlog over native alarm wakes without losing or duplicating jobs",
    Effect.gen(function* () {
      const { url } = yield* stack;
      yield* json(`${url}/batch/batch`, "POST");
      const result = yield* poll<Snapshot>(
        `${url}/batch/snapshot`,
        drained(105),
      );
      expect(deliveries(result)).toEqual(
        Array.from({ length: 105 }, (_, i) => `archive:batch-${i}`).sort(),
      );
      expect(result.alarm).toBeNull();
    }),
    { timeout: 90_000 },
  );

  test(
    "legacy scheduling and its native alarm handler coexist with registered callbacks",
    Effect.gen(function* () {
      const { url } = yield* stack;
      yield* json(`${url}/legacy/legacy`, "POST");
      const result = yield* poll<{
        registered: string | null;
        legacy: { id: string; payload: { value: string } }[];
        pending: unknown[];
        alarm: number | null;
      }>(
        `${url}/legacy/legacy`,
        (value) =>
          value.registered !== null &&
          value.legacy.length === 1 &&
          value.alarm === null,
      );
      expect(result.registered).toBe("registered");
      expect(result.legacy).toHaveLength(1);
      expect(result.legacy[0]?.id).toBe("shared-id");
      expect(result.legacy[0]?.payload).toEqual({ value: "legacy" });
      expect(result.pending).toEqual([]);
      expect(result.alarm).toBeNull();
    }),
    { timeout: 90_000 },
  );
});
