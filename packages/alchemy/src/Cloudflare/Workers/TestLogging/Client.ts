/**
 * Node-side client for the `alchemy-test-logger` Durable Object, used by the
 * test harness (`Test/Vitest.ts`, `Test/Bun.ts`):
 *
 * - {@link streamTestLogs} — long-lived websocket subscription for one
 *   test's request ID, printing rows as they arrive. Forked for the duration
 *   of the test body and interrupted when it ends.
 * - {@link flushTestLogs} — delete-and-return buffered rows over HTTP; used
 *   at test end (to catch trailing `waitUntil` logs) and in `afterAll` (to
 *   surface unattributed logs from the `default` bucket).
 *
 * Rows are only ever deleted by `flush`; the stream leaves them buffered, so
 * a shared `seen` set (per test file) dedupes across the two paths and
 * across websocket reconnects.
 */
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Socket from "effect/unstable/socket/Socket";
import { DEFAULT_REQUEST_ID, type TestLogRow } from "./constants.ts";
import type { TestLoggerTarget } from "./Registry.ts";

const rowKey = (target: TestLoggerTarget, row: TestLogRow) =>
  `${target.doName}#${row.id}`;

const printTestLogRow = (
  target: TestLoggerTarget,
  row: TestLogRow,
  seen: Set<string>,
): void => {
  const key = rowKey(target, row);
  if (seen.has(key)) return;
  seen.add(key);
  const prefix = row.workerName ? `[${row.workerName}]` : "[worker]";
  const line =
    row.method === "log" || row.method === "info"
      ? `${prefix} ${row.message}`
      : `${prefix} ${row.method}: ${row.message}`;
  if (row.method === "error") {
    console.error(line);
  } else if (row.method === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
};

const tailUrl = (target: TestLoggerTarget, requestId: string) =>
  `${target.loggerUrl.replace(/^http/, "ws")}/__alchemy/tail?do=${encodeURIComponent(
    target.doName,
  )}&requestId=${encodeURIComponent(requestId)}`;

const flushUrl = (target: TestLoggerTarget, requestId: string | undefined) =>
  `${target.loggerUrl}/__alchemy/flush?do=${encodeURIComponent(target.doName)}${
    requestId === undefined ? "" : `&requestId=${encodeURIComponent(requestId)}`
  }`;

/**
 * Subscribe to the logger DO and print every row for `requestId` as it
 * arrives. Reconnects while running (backlog replay + `seen` make that
 * loss-free); intended to be forked and interrupted by the caller — it
 * never terminates on its own.
 */
export const streamTestLogs = (
  target: TestLoggerTarget,
  requestId: string,
  seen: Set<string>,
) => {
  const session = Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(tailUrl(target, requestId));
    yield* socket.runRaw((raw) => {
      try {
        const text =
          typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        printTestLogRow(target, JSON.parse(text) as TestLogRow, seen);
      } catch {
        // Malformed frame — never break the test over log plumbing.
      }
    });
  });
  // A fresh logger worker's workers.dev URL propagates over a few seconds,
  // and Cloudflare closes idle hibernatable sockets — keep (re)connecting
  // until the surrounding fiber is interrupted at test end.
  return session.pipe(
    Effect.ignore,
    Effect.repeat(Schedule.spaced("500 millis")),
  );
};

/**
 * Delete-and-return buffered rows for `requestId` (or every row when
 * `requestId` is `undefined` — the `afterAll` catch-all) and print the ones
 * not already streamed. Failures are swallowed after a short bounded retry;
 * log plumbing must never fail a test.
 */
export const flushTestLogs = (
  target: TestLoggerTarget,
  requestId: string | undefined,
  seen: Set<string>,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(flushUrl(target, requestId)).pipe(
      Effect.timeout("5 seconds"),
      Effect.retry({
        schedule: Schedule.exponential(250).pipe(
          Schedule.both(Schedule.recurs(3)),
        ),
      }),
    );
    const rows = (yield* response.json) as unknown as TestLogRow[];
    for (const row of rows) {
      printTestLogRow(target, row, seen);
    }
  }).pipe(Effect.ignore);

export { DEFAULT_REQUEST_ID };
