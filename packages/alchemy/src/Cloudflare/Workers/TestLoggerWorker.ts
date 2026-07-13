import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import { sha256 } from "../../Util/sha256";

export const TEST_LOGGER_WORKER_NAME = "alchemy-test-logger";

/**
 * Source of the account-level `alchemy-test-logger` worker. Kept as a raw,
 * dependency-free ESM string so the provider can upload it directly (like
 * the pre-create placeholder script) without a bundling step, and so its
 * content hash deterministically versions the deployed singleton.
 *
 * The worker hosts one `AlchemyTestLogger` Durable Object class. Instances
 * are keyed by `{stackName}/{stage}` (the `do` query param); each instance
 * buffers log rows in SQLite and streams rows matching a request ID over
 * websockets tagged with that ID:
 *
 * - `GET /__alchemy/tail?do=<name>&requestId=<id>` — upgrade to a websocket,
 *   replay buffered rows for `<id>`, then push new ones live.
 * - `GET /__alchemy/flush?do=<name>[&requestId=<id>]` — delete-and-return
 *   buffered rows (all rows when `requestId` is omitted).
 *
 * Rows are only deleted by `flush` — the streaming path leaves them in
 * place and the Node client dedupes by row id, which keeps the protocol
 * one-directional.
 */
const TEST_LOGGER_CLASS_NAME = "AlchemyTestLogger";
const LOGGER_WORKER_SCRIPT = `import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__alchemy/")) {
      const doName = url.searchParams.get("do") ?? "default";
      return env.LOGGER.getByName(doName).fetch(request);
    }
    return new Response("alchemy-test-logger", { status: 200 });
  },
};

export class ${TEST_LOGGER_CLASS_NAME} extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        \`CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message TEXT NOT NULL,
          method TEXT NOT NULL,
          workerName TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          requestId TEXT NOT NULL
        )\`,
      );
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/__alchemy/tail": {
        const requestId = url.searchParams.get("requestId") ?? "default";
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server, [requestId]);
        for (const row of this.ctx.storage.sql.exec(
          "SELECT * FROM logs WHERE requestId = ? ORDER BY id ASC",
          requestId,
        )) {
          server.send(JSON.stringify(row));
        }
        return new Response(null, { status: 101, webSocket: client });
      }
      case "/__alchemy/flush": {
        const requestId = url.searchParams.get("requestId");
        const rows = requestId
          ? this.ctx.storage.sql
              .exec("DELETE FROM logs WHERE requestId = ? RETURNING *", requestId)
              .toArray()
          : this.ctx.storage.sql.exec("DELETE FROM logs RETURNING *").toArray();
        return Response.json(rows);
      }
      default: {
        return new Response("Not found", { status: 404 });
      }
    }
  }

  async log(entry) {
    const row = this.ctx.storage.sql
      .exec(
        "INSERT INTO logs (message, method, workerName, timestamp, requestId) VALUES (?, ?, ?, ?, ?) RETURNING *",
        String(entry.message ?? ""),
        String(entry.method ?? "log"),
        String(entry.workerName ?? ""),
        Date.now(),
        String(entry.requestId ?? "default"),
      )
      .one();
    for (const ws of this.ctx.getWebSockets(row.requestId)) {
      try {
        ws.send(JSON.stringify(row));
      } catch {}
    }
  }
}
`;

const ensureTestLoggerWorker = Effect.fn(function* (accountId: string) {
  const versionTag = yield* sha256(LOGGER_WORKER_SCRIPT);

  const existing = yield* workers
    .getScriptScriptAndVersionSetting({
      accountId,
      scriptName: TEST_LOGGER_WORKER_NAME,
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
      binding.className === TEST_LOGGER_CLASS_NAME,
  );

  if (hasVersionTag && hasClass) {
    return;
  }

  yield* workers
    .putScript({
      accountId,
      scriptName: TEST_LOGGER_WORKER_NAME,
      metadata: {
        mainModule: "main.mjs",
        compatibilityDate: "2026-03-17",
        bindings: [
          {
            type: "durable_object_namespace",
            name: "LOGGER",
            className: TEST_LOGGER_CLASS_NAME,
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
              newSqliteClasses: [TEST_LOGGER_CLASS_NAME],
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
    .pipe(transientRetry());
  yield* workers
    .createScriptSubdomain({
      accountId,
      scriptName: "alchemy-test-logger",
      enabled: true,
      previewsEnabled: true,
    })
    .pipe(transientRetry());
});

const transientRetry = () =>
  Effect.retry({
    while: (e) =>
      Predicate.isTagged(e, "WorkerNotFound") ||
      Predicate.isTagged(e, "InternalServerError") ||
      Predicate.isTagged(e, "UnknownCloudflareError"),
    schedule: Schedule.exponential(200),
    times: 10,
  });

/**
 * Opt-in switch for the test-logging pipeline, read by the Cloudflare
 * Worker provider during diff/reconcile. A `Context.Reference` so it
 * defaults to `false` everywhere (CLI deploys never see it) and the test
 * harness can flip it on for a whole deploy with a single
 * `Effect.provideService` — no fixture/stack changes required.
 */
export const TestLoggingPolicy = Context.Reference<boolean>(
  "alchemy/Cloudflare/TestLoggingPolicy",
  { defaultValue: () => false },
);
export const testLoggerBindings = (workerName: string, doName: string) =>
  [
    {
      type: "durable_object_namespace" as const,
      name: "ALCHEMY_TEST_LOGGER",
      className: TEST_LOGGER_CLASS_NAME,
      scriptName: TEST_LOGGER_WORKER_NAME,
    },
    {
      type: "plain_text" as const,
      name: "ALCHEMY_TEST_LOGGER_WORKER_NAME",
      text: workerName,
    },
    {
      type: "plain_text" as const,
      name: "ALCHEMY_TEST_LOGGER_DO_NAME",
      text: doName,
    },
  ] satisfies workers.PutScriptRequest["metadata"]["bindings"];
