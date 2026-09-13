/**
 * The **Durable Object engine conformance spec**, run against Cloudflare,
 * celld and Rivet: one frozen set of behaviors, driven over HTTP against a
 * deployed worker (or a caller that fronts it).
 *
 * The point of the portable surface is that the SAME Durable Object code
 * runs on all three engines. This file is how that claim is kept honest:
 * each engine's live suite deploys the shared fixture (`counter.ts` + its
 * own target layer) and runs {@link conformanceTests} against the
 * resulting URL. Every engine is asserted against the full spec — a
 * capability that only works on one engine is a bug in that engine's
 * adapter, not a property of the fixture.
 *
 * Routes the fixture worker must expose (see `routes.ts`):
 *
 * | route                          | exercises                          |
 * |--------------------------------|------------------------------------|
 * | `/kv/{cell}/increment`         | `storage.get` + `storage.put`      |
 * | `/kv/{cell}/get`               | read-back, per-cell isolation      |
 * | `/kv/{cell}/list?prefix=`      | `storage.list`                     |
 * | `/kv/{cell}/delete?key=`       | `storage.delete`                   |
 * | `/sql/{cell}/clear`            | `storage.sql.exec` DELETE          |
 * | `/sql/{cell}/insert?v=`        | `storage.sql.exec` with bindings   |
 * | `/sql/{cell}/all`              | `storage.sql` read-back            |
 * | `/alarm/{cell}/arm?ms=`        | `storage.setAlarm`                 |
 * | `/alarm/{cell}/peek`           | `storage.getAlarm`                 |
 * | `/alarm/{cell}/cancel`         | `storage.deleteAlarm`              |
 * | `/alarm/{cell}/fired`          | the `alarm` handler ran            |
 * | `/stream/{cell}?n=`            | a `Stream`-returning RPC method    |
 * | `/fail/{cell}`                 | typed `Effect.fail` round-trip     |
 */
import type { TestApi } from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

export interface ConformanceContext {
  /** Base URL of the deployed worker (or a caller that fronts it). */
  readonly baseUrl: () => string;
}

/** The upstream is still rolling out (transport error or 5xx). */
class UpstreamNotReady extends Data.TaggedError("UpstreamNotReady")<{
  readonly url: string;
  readonly detail: string;
  readonly message: string;
}> {}

const notReady = (url: string, detail: string) =>
  new UpstreamNotReady({ url, detail, message: `${url}: ${detail}` });

/**
 * GET a conformance route and decode its JSON body.
 *
 * Only transport errors and 5xx are retried (bounded): every conformance
 * route is a real route, so once {@link waitForReady} has passed a 404 is a
 * missing route, not warm-up, and fails the test immediately.
 */
const get = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.mapError((cause) => notReady(url, String(cause))),
    Effect.flatMap((response) =>
      response.status >= 500
        ? Effect.fail(notReady(url, `upstream ${response.status}`))
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e): boolean => e._tag === "UpstreamNotReady",
      schedule: Schedule.exponential("500 millis"),
      times: 6,
    }),
    Effect.flatMap((response) => response.json),
  );

/**
 * Block until the deployed worker actually serves a conformance route.
 * Engine suites call this from `beforeAll` so propagation delay surfaces
 * as one slow hook rather than a wall of 404s across every test.
 *
 * 404 counts as warming HERE (and only here): a 404 on the readiness
 * route means the edge has not yet mapped the hostname to the freshly
 * deployed worker (workers.dev propagation answers `404 error code: 1042`
 * for up to a minute after a first deploy).
 *
 * The default budget (30 × 5s ≈ 2.5 min) sits inside the Cloudflare
 * suite's 300s `beforeAll` timeout; the Fargate suites pass a larger one.
 */
export const waitForReady = (
  baseUrl: string,
  options?: { attempts?: number; base?: Duration.Input },
) => {
  const url = `${baseUrl}/kv/__readiness/get`;
  return HttpClient.get(url).pipe(
    Effect.mapError((cause) => notReady(url, String(cause))),
    Effect.flatMap((response) =>
      response.status >= 500 || response.status === 404
        ? Effect.fail(notReady(url, `not ready: ${response.status}`))
        : Effect.succeed(response.status),
    ),
    Effect.retry({
      while: (e): boolean => e._tag === "UpstreamNotReady",
      schedule: Schedule.fixed(options?.base ?? "5 seconds"),
      times: options?.attempts ?? 30,
    }),
  );
};

/**
 * Register the nine conformance tests. `test` is the engine suite's own
 * test function so timeouts/skips stay under the suite's control.
 */
export const conformanceTests = (
  test: TestApi["test"],
  ctx: ConformanceContext,
) => {
  const url = (path: string) => `${ctx.baseUrl()}${path}`;
  const timeout = { timeout: 120_000 };

  test(
    "kv: writes persist across calls to the same cell",
    Effect.gen(function* () {
      const first = (yield* get(url("/kv/a/increment"))) as { value: number };
      const second = (yield* get(url("/kv/a/increment"))) as { value: number };
      expect(second.value).toBe(first.value + 1);
      const read = (yield* get(url("/kv/a/get"))) as { value: number };
      expect(read.value).toBe(second.value);
    }),
    timeout,
  );

  test(
    "kv: cells are isolated by name",
    Effect.gen(function* () {
      yield* get(url("/kv/b/increment"));
      const fresh = (yield* get(url("/kv/never-touched/get"))) as {
        value: number;
      };
      expect(fresh.value).toBe(0);
    }),
    timeout,
  );

  test(
    "kv: list and delete",
    Effect.gen(function* () {
      yield* get(url("/kv/c/increment"));
      const listed = (yield* get(url("/kv/c/list?prefix=count"))) as {
        keys: string[];
      };
      expect(listed.keys).toContain("count");
      yield* get(url("/kv/c/delete?key=count"));
      const after = (yield* get(url("/kv/c/list?prefix=count"))) as {
        keys: string[];
      };
      expect(after.keys).not.toContain("count");
    }),
    timeout,
  );

  test(
    "streaming: a Stream-returning method round-trips",
    Effect.gen(function* () {
      const result = (yield* get(url("/stream/a?n=5"))) as { values: number[] };
      expect(result.values).toEqual([1, 2, 3, 4, 5]);
    }),
    timeout,
  );

  test(
    "errors: a typed Effect.fail keeps its tag across the wire",
    Effect.gen(function* () {
      const result = (yield* get(url("/fail/a"))) as { tag: string };
      expect(result.tag).toBe("CounterBoom");
    }),
    timeout,
  );

  test(
    "sql: exec with bindings, then read back",
    Effect.gen(function* () {
      // Clear first: the runner retries a failing body, and a retry that
      // re-inserted into a cell that already holds rows would read 4.
      yield* get(url("/sql/s1/clear"));
      yield* get(url("/sql/s1/insert?v=hello"));
      yield* get(url("/sql/s1/insert?v=world"));
      const rows = (yield* get(url("/sql/s1/all"))) as {
        rows: { v: string }[];
      };
      expect(rows.rows.map((r) => r.v).sort()).toEqual(["hello", "world"]);
    }),
    timeout,
  );

  test(
    "sql: storage is isolated per cell",
    Effect.gen(function* () {
      const rows = (yield* get(url("/sql/s2/all"))) as { rows: unknown[] };
      expect(rows.rows).toEqual([]);
    }),
    timeout,
  );

  test(
    "alarms: setAlarm fires the alarm handler and clears",
    Effect.gen(function* () {
      yield* get(url("/alarm/t1/arm?ms=1500"));
      const armed = (yield* get(url("/alarm/t1/peek"))) as {
        time: number | null;
      };
      expect(armed.time).not.toBeNull();

      // Poll rather than sleep-and-hope: bounded, and fails fast.
      const fired = yield* get(url("/alarm/t1/fired")).pipe(
        Effect.map((r) => (r as { count: number }).count),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (count) => count > 0,
          times: 20,
        }),
      );
      expect(fired).toBeGreaterThan(0);

      const cleared = (yield* get(url("/alarm/t1/peek"))) as {
        time: number | null;
      };
      expect(cleared.time).toBeNull();
    }),
    // The alarm fires ~1.5s after arming; the budget covers the bounded
    // 20 × 1s poll plus per-request retries on a cold engine.
    { timeout: 180_000 },
  );

  test(
    "alarms: deleteAlarm cancels a pending alarm",
    Effect.gen(function* () {
      yield* get(url("/alarm/t2/arm?ms=1500"));
      yield* get(url("/alarm/t2/cancel"));
      const peeked = (yield* get(url("/alarm/t2/peek"))) as {
        time: number | null;
      };
      expect(peeked.time).toBeNull();

      // Wait past when it would have fired; it must not have.
      yield* Effect.sleep("4 seconds");
      const fired = (yield* get(url("/alarm/t2/fired"))) as { count: number };
      expect(fired.count).toBe(0);
    }),
    { timeout: 180_000 },
  );
};
