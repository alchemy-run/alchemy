import * as workers from "@distilled.cloud/cloudflare/workers";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import * as path from "pathe";
import { rootDir } from "../../Auth/Profile.ts";
import type { LogLine } from "../../Provider.ts";
import * as FileSemaphore from "../../Util/FileSemaphore.ts";
import { sha256 } from "../../Util/sha256.ts";
import {
  Constants,
  testLoggerInstanceName,
  type TestLogRow,
} from "./TestLoggerConstants.ts";

/**
 * Deploy-side half of the test-logging pipeline.
 *
 * Cloudflare's tail API delivers logs with multi-second latency — too slow
 * for tests. Instead, workers deployed with {@link TestLoggingPolicy} enabled
 * get their `console.*` patched (see `TestLoggerRuntime.ts`) to mirror log
 * lines into an account-level singleton worker (`alchemy-test-logger`)
 * hosting a SQLite-buffered Durable Object per stack+stage. The
 * {@link testLoggerTail} client streams those rows over a websocket with
 * sub-second latency, replaying anything buffered before it connected.
 */

/**
 * Opt-in switch for the test-logging pipeline, read by the Cloudflare
 * Worker provider during reconcile. A `Context.Reference` so it defaults
 * to `false` everywhere (CLI deploys never see it) and the test harness
 * can flip it on for a whole deploy with a single `Effect.provideService`
 * — no fixture/stack changes required.
 */
export const TestLoggingPolicy = Context.Reference<boolean>(
  "alchemy/Cloudflare/TestLoggingPolicy",
  { defaultValue: () => false },
);

/**
 * Source of the account-level `alchemy-test-logger` worker. Kept as a raw,
 * dependency-free ESM string so the provider can upload it directly (like
 * the pre-create placeholder script) without a bundling step, and so its
 * content hash deterministically versions the deployed singleton.
 *
 * The worker hosts one `AlchemyTestLogger` Durable Object class. Instances
 * are keyed by `{stackName}/{stage}` (the `do` query param); each instance
 * buffers log rows in SQLite and serves one websocket route:
 *
 * - `GET /tail?do=<name>&worker=<script>` — upgrade to a websocket,
 *   delete-and-replay buffered rows for `<script>`, then push new ones
 *   live. Delete-on-connect keeps the buffer bounded to un-tailed rows;
 *   rows pushed live stay in the table until the next connect, so a
 *   reconnect after a websocket drop replays anything missed (the client
 *   dedupes by monotonic row id).
 */
const LOGGER_WORKER_SCRIPT = `import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/tail") {
      const name = url.searchParams.get("do");
      if (!name) return new Response("Missing do", { status: 400 });
      return env.LOGGER.getByName(name).fetch(request);
    }
    return new Response("alchemy-test-logger", { status: 200 });
  },
};

const MAX_ROW_AGE_MS = 60 * 60 * 1000;

export class ${Constants.TEST_LOGGER_CLASS_NAME} extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        \`CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          worker TEXT NOT NULL,
          message TEXT NOT NULL,
          method TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        )\`,
      );
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const worker = url.searchParams.get("worker");
    if (!worker) {
      return new Response("Missing worker", { status: 400 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [worker]);
    for (const row of this.ctx.storage.sql.exec(
      "DELETE FROM logs WHERE worker = ? RETURNING *",
      worker,
    )) {
      server.send(JSON.stringify(row));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async log(entry) {
    this.ctx.storage.sql.exec(
      "DELETE FROM logs WHERE timestamp < ?",
      Date.now() - MAX_ROW_AGE_MS,
    );
    const row = this.ctx.storage.sql
      .exec(
        "INSERT INTO logs (worker, message, method, timestamp) VALUES (?, ?, ?, ?) RETURNING *",
        entry.worker,
        entry.message,
        entry.method,
        Date.now(),
      )
      .one();
    for (const ws of this.ctx.getWebSockets(entry.worker)) {
      try {
        ws.send(JSON.stringify(row));
      } catch {}
    }
  }
}
`;

const transientRetry = <E>(): Effect.Retry.Options<E> => ({
  while: (e: E) =>
    Predicate.isTagged(e, "WorkerNotFound") ||
    Predicate.isTagged(e, "InternalServerError") ||
    Predicate.isTagged(e, "UnknownCloudflareError"),
  schedule: Schedule.exponential(200),
  times: 10,
});

// Cross-process mutex so concurrent test processes on this machine don't
// race `putScript` on the singleton. Same lock directory as the auth lock.
const ensureLock = FileSemaphore.make({
  directory: path.join(rootDir, "lock"),
});

// Accounts whose logger worker this process has already verified. Only
// successes are recorded, so a failed ensure is retried on the next deploy.
const ensured = new Set<string>();

const putTestLoggerWorker = Effect.fn(function* (
  accountId: string,
  versionTag: string,
  hasClass: boolean,
) {
  yield* workers
    .putScript({
      accountId,
      scriptName: Constants.TEST_LOGGER_WORKER_NAME,
      metadata: {
        mainModule: "main.mjs",
        compatibilityDate: "2026-03-17",
        bindings: [
          {
            type: "durable_object_namespace",
            name: "LOGGER",
            className: Constants.TEST_LOGGER_CLASS_NAME,
          },
        ],
        migrations: hasClass
          ? undefined
          : {
              oldTag: undefined,
              newTag: undefined,
              newClasses: [],
              deletedClasses: [],
              renamedClasses: [],
              transferredClasses: [],
              newSqliteClasses: [Constants.TEST_LOGGER_CLASS_NAME],
            },
        // The logger must not tail itself into Workers Logs noise.
        observability: { enabled: false },
        tags: [versionTag],
      },
      files: [
        new File([LOGGER_WORKER_SCRIPT], "main.mjs", {
          type: "application/javascript+module",
        }),
      ],
    })
    .pipe(Effect.retry(transientRetry()));
  yield* workers
    .createScriptSubdomain({
      accountId,
      scriptName: Constants.TEST_LOGGER_WORKER_NAME,
      enabled: true,
      previewsEnabled: true,
    })
    .pipe(Effect.retry(transientRetry()));
});

const checkAndPutTestLoggerWorker = Effect.fn(function* (accountId: string) {
  const versionTag = yield* sha256(LOGGER_WORKER_SCRIPT).pipe(
    Effect.map((hash) => `${Constants.TEST_LOGGER_WORKER_NAME}:${hash}`),
  );

  const existing = yield* workers
    .getScriptScriptAndVersionSetting({
      accountId,
      scriptName: Constants.TEST_LOGGER_WORKER_NAME,
    })
    .pipe(
      Effect.catchTag(
        ["WorkerNotFound", "WorkerHasNoVersions"],
        () => Effect.undefined,
      ),
    );

  const hasVersionTag = existing?.tags?.includes(versionTag) ?? false;
  const hasClass = (existing?.bindings ?? []).some(
    (binding) =>
      binding.type === "durable_object_namespace" &&
      "className" in binding &&
      binding.className === Constants.TEST_LOGGER_CLASS_NAME,
  );

  if (!hasVersionTag || !hasClass) {
    yield* Effect.logInfo(
      `Deploying test logger worker '${Constants.TEST_LOGGER_WORKER_NAME}' to account ${accountId}`,
    );
    yield* putTestLoggerWorker(accountId, versionTag, hasClass);
  }
});

/**
 * Ensure the account-level `alchemy-test-logger` singleton exists and is at
 * the current script version. Called lazily by the Worker provider right
 * before deploying a worker with test logging enabled.
 *
 * Runs at most once per account per process (memoized on success) and is
 * serialized across processes on the same machine with a file lock, so
 * concurrent test runs never race `putScript`.
 */
export const ensureTestLoggerWorker = Effect.fn(function* (accountId: string) {
  if (ensured.has(accountId)) return;
  yield* ensureLock.withPermit(`cloudflare-test-logger-${accountId}`)(
    Effect.gen(function* () {
      // Re-check inside the lock: another fiber may have completed the
      // ensure while this one was waiting for the permit.
      if (ensured.has(accountId)) return;
      yield* checkAndPutTestLoggerWorker(accountId);
      ensured.add(accountId);
    }),
  );
});

/**
 * The metadata bindings injected into a worker deployed with test logging:
 * the cross-script DO namespace pointing at the logger singleton, plus the
 * worker's own script name so the runtime patch can tag its rows.
 */
export const testLoggerBindings = (workerName: string) =>
  [
    {
      type: "durable_object_namespace" as const,
      name: Constants.TEST_LOGGER_DO_BINDING,
      className: Constants.TEST_LOGGER_CLASS_NAME,
      scriptName: Constants.TEST_LOGGER_WORKER_NAME,
    },
    {
      type: "plain_text" as const,
      name: Constants.TEST_LOGGER_WORKER_NAME_BINDING,
      text: workerName,
    },
  ] satisfies workers.PutScriptRequest["metadata"]["bindings"];

/**
 * `true` when a worker's observed settings carry the test-logger DO binding
 * — how `read` reconstructs the `testLogger` attribute from cloud state.
 */
export const hasTestLoggerBinding = (
  bindings:
    | readonly { type?: string | undefined; name?: string | undefined }[]
    | null
    | undefined,
): boolean =>
  (bindings ?? []).some(
    (binding) =>
      binding.type === "durable_object_namespace" &&
      binding.name === Constants.TEST_LOGGER_DO_BINDING,
  );

/**
 * Grace window subtracted from the tail start time when filtering replayed
 * rows. Rows older than this predate the current run (buffered by a previous
 * test run against the same stack/stage) and are dropped instead of being
 * replayed into the new run's output. Generous enough to absorb clock skew
 * between this machine and Cloudflare.
 */
const REPLAY_WINDOW_MS = 15_000;

/**
 * Stream a worker's buffered + live console logs from the test-logger
 * Durable Object. The faster alternative to `CloudflareLogs.tailScript`,
 * used by the Worker provider's `tail` when the worker was deployed with
 * test logging enabled.
 *
 * Mirrors `tailScript`'s session shape: websocket into an Effect `Queue`,
 * reconnect on close with a spaced schedule. Rows are deduped by monotonic
 * row id across reconnects (delete-on-connect replays anything buffered
 * during the gap).
 */
export const testLoggerTail = (opts: {
  accountId: string;
  workerName: string;
  stack: { name: string; stage: string };
}) => {
  // Persist across reconnect sessions so replayed rows aren't re-emitted.
  let lastId = 0;
  const sinceFloor = Date.now() - REPLAY_WINDOW_MS;

  const runTailSession = Effect.gen(function* () {
    const { subdomain } = yield* workers.getSubdomain({
      accountId: opts.accountId,
    });
    const url = new URL(
      `wss://${Constants.TEST_LOGGER_WORKER_NAME}.${subdomain}.workers.dev/tail`,
    );
    url.searchParams.set("do", testLoggerInstanceName(opts.stack));
    url.searchParams.set("worker", opts.workerName);

    const socket = yield* Socket.makeWebSocket(url.toString(), {
      openTimeout: "5 seconds",
    });

    const queue = yield* Queue.make<LogLine, Cause.Done>();

    yield* socket
      .runString((raw) => {
        const row: TestLogRow = JSON.parse(raw);
        if (row.id <= lastId || row.timestamp < sinceFloor) return;
        lastId = row.id;
        Queue.offerUnsafe(queue, {
          timestamp: new Date(row.timestamp),
          message:
            row.method === "log"
              ? row.message
              : `${row.method}: ${row.message}`,
        });
      })
      .pipe(
        Effect.ensuring(Queue.end(queue)),
        Effect.ignore,
        Effect.forkChild(),
      );

    return Stream.fromQueue(queue);
  });

  return Stream.unwrap(runTailSession).pipe(
    Stream.repeat(Schedule.spaced("1 second")),
  );
};
