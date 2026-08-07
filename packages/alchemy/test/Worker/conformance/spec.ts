/**
 * The **engine conformance spec**: one set of behaviors every
 * `Alchemy.Worker` engine must satisfy, driven over HTTP against a
 * deployed worker.
 *
 * The point of the portable surface is that the SAME Durable Object code
 * runs on Cloudflare, celld, and Rivet. This file is how that claim is
 * kept honest: each engine's live suite deploys the shared fixture
 * (`fixtures/counter.ts` + its own target layer) and runs
 * {@link conformanceTests} against the resulting URL. A capability that
 * only works on one engine is a bug in that engine's adapter, not a
 * property of the fixture.
 *
 * Routes the fixture worker must expose (see `fixtures/routes.ts`):
 *
 * | route                          | exercises                          |
 * |--------------------------------|------------------------------------|
 * | `/kv/{cell}/increment`         | `storage.get` + `storage.put`      |
 * | `/kv/{cell}/get`               | read-back, per-cell isolation      |
 * | `/kv/{cell}/list?prefix=`      | `storage.list`                     |
 * | `/kv/{cell}/delete?key=`       | `storage.delete`                   |
 * | `/sql/{cell}/insert?v=`        | `storage.sql.exec` with bindings   |
 * | `/sql/{cell}/all`              | `storage.sql` read-back            |
 * | `/alarm/{cell}/arm?ms=`        | `storage.setAlarm`                 |
 * | `/alarm/{cell}/peek`           | `storage.getAlarm`                 |
 * | `/alarm/{cell}/cancel`         | `storage.deleteAlarm`              |
 * | `/alarm/{cell}/fired`          | the `alarm` handler ran            |
 * | `/stream/{cell}?n=`            | a `Stream`-returning RPC method    |
 * | `/fail/{cell}`                 | typed `Effect.fail` round-trip     |
 */
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

/** Which optional capabilities an engine claims to support. */
export interface EngineCapabilities {
  /** Per-object SQL storage (`storage.sql`). */
  readonly sql: boolean;
  /** Durable Object alarms (`storage.setAlarm` and the `alarm` handler). */
  readonly alarms: boolean;
}

export interface ConformanceContext {
  /** Base URL of the deployed worker (or a caller that fronts it). */
  readonly baseUrl: () => string;
  readonly capabilities: EngineCapabilities;
}

/**
 * GET a route, retrying while the deployment warms.
 *
 * 404 is retryable here: every conformance route is a real route, so a
 * 404 means the edge has not yet mapped the hostname to the freshly
 * deployed worker (workers.dev propagation answers `404 error code:
 * 1042` for up to a minute after a first deploy).
 */
const warming = (status: number) => status >= 500 || status === 404;

const get = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      warming(response.status)
        ? Effect.fail(new Error(`upstream ${response.status}`))
        : Effect.succeed(response),
    ),
    Effect.retry({
      schedule: Schedule.exponential("500 millis"),
      times: 6,
    }),
    Effect.flatMap((response) => response.json),
  );

/**
 * Block until the deployed worker actually serves a conformance route.
 * Engine suites call this from `beforeAll` so propagation delay surfaces
 * as one slow hook rather than a wall of 404s across every test.
 */
export const waitForReady = (
  baseUrl: string,
  options?: { attempts?: number; base?: string },
) =>
  HttpClient.get(`${baseUrl}/kv/__readiness/get`).pipe(
    Effect.flatMap((response) =>
      warming(response.status)
        ? Effect.fail(new Error(`not ready: ${response.status}`))
        : Effect.succeed(response.status),
    ),
    Effect.retry({
      schedule:
        options?.base === undefined
          ? Schedule.exponential("1 second", 1.4)
          : Schedule.fixed(options.base as any),
      times: options?.attempts ?? 15,
    }),
  );

/**
 * Register the conformance tests. `test` is the engine suite's own test
 * function so timeouts/skips stay under the suite's control.
 */
export const conformanceTests = (
  test: (
    name: string,
    body: Effect.Effect<void, any, any>,
    options?: { timeout?: number },
  ) => void,
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

  if (ctx.capabilities.sql) {
    test(
      "sql: exec with bindings, then read back",
      Effect.gen(function* () {
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
  }

  if (ctx.capabilities.alarms) {
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
  }
};
