import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { cast } from "effect/Function";
import * as Layer from "effect/Layer";
import * as PartitionedSemaphore from "effect/PartitionedSemaphore";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Socket from "effect/unstable/socket/Socket";
import { sha256 } from "../../Util/sha256.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";

export const Constants = {
  TEST_LOGGER_WORKER_NAME: "alchemy-test-logger",
  TEST_LOGGER_CLASS_NAME: "AlchemyTestLogger",
  TEST_LOGGER_DO_BINDING: "ALCHEMY_TEST_LOGGER",
  TEST_LOGGER_WORKER_NAME_BINDING: "ALCHEMY_TEST_LOGGER_WORKER_NAME",
} as const;

const semaphore = PartitionedSemaphore.makeUnsafe<string>({ permits: 1 });

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
const LOGGER_WORKER_SCRIPT = `import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__alchemy/")) {
      return env.LOGGER.getByName("global").fetch(request);
    }
    return new Response("alchemy-test-logger", { status: 200 });
  },
};

export class ${Constants.TEST_LOGGER_CLASS_NAME} extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        \`CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          stack TEXT NOT NULL,
          stage TEXT NOT NULL,
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
    const stack = url.searchParams.get("stack");
    const stage = url.searchParams.get("stage");
    if (!stack || !stage) {
      return new Response("Missing stack or stage", { status: 400 });
    }
    switch (url.pathname) {
      case "/__alchemy/tail": {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server, [\`\${stack}:\${stage}\`]);
        for (const row of this.ctx.storage.sql.exec(
          "DELETE FROM logs WHERE stack = ? AND stage = ? RETURNING *",
          stack,
          stage,
        )) {
          server.send(JSON.stringify(row));
        }
        return new Response(null, { status: 101, webSocket: client });
      }
      case "/__alchemy/flush": {
        const rows = this.ctx.storage.sql
          .exec("DELETE FROM logs WHERE stack = ? AND stage = ? RETURNING *", stack, stage)
          .toArray();
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
        "INSERT INTO logs (stack, stage, worker, message, method, timestamp) VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
        entry.stack,
        entry.stage,
        entry.worker,
        entry.message,
        entry.method,
        Date.now(),
      )
      .one();
    for (const ws of this.ctx.getWebSockets(\`\${row.stack}:\${row.stage}\`)) {
      try {
        ws.send(JSON.stringify(row));
      } catch {}
    }
  }
}
`;

const ensureTestLoggerWorker = Effect.fn(
  function* (accountId: string) {
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

    if (hasVersionTag && hasClass) {
      console.log(
        "[test logger] TEST LOGGER WORKER ALREADY EXISTS",
        versionTag,
        hasClass,
      );
      return;
    }

    console.log(
      "[test logger] CREATING TEST LOGGER WORKER",
      versionTag,
      hasClass,
    );

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
  },
  (self, accountId) => semaphore.withPermit(accountId)(self),
);

const transientRetry = <E>(): Effect.Retry.Options<E> => ({
  while: (e: E) =>
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

export const testLoggerBindings = (workerName: string) =>
  [
    {
      type: "durable_object_namespace" as const,
      name: "ALCHEMY_TEST_LOGGER",
      className: Constants.TEST_LOGGER_CLASS_NAME,
      scriptName: Constants.TEST_LOGGER_WORKER_NAME,
    },
    {
      type: "plain_text" as const,
      name: Constants.TEST_LOGGER_WORKER_NAME_BINDING,
      text: workerName,
    },
  ] satisfies workers.PutScriptRequest["metadata"]["bindings"];

export const enableTestLogging = Layer.unwrap(
  Effect.gen(function* () {
    const enable = yield* TestLoggingPolicy;
    if (enable) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      console.log("[test logger] ENSURING TEST LOGGER WORKER", accountId);
      yield* ensureTestLoggerWorker(accountId);
    } else {
      console.log("[test logger] TEST LOGGER NOT ENABLED");
    }
    return Layer.empty;
  }),
);

export class TestLogger extends Context.Service<
  TestLogger,
  {
    run: (url: URL) => Effect.Effect<void, Socket.SocketError, Scope.Scope>;
  }
>()("TestLogger") {}

export const make = (stack: { name: string; stage: string }) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const context = yield* Effect.context<Socket.WebSocketConstructor>();
    interface Log {
      id: number;
      message: string;
      method: "log" | "error" | "warn" | "debug" | "info" | "trace" | "dir";
      timestamp: number;
      stack: string;
      stage: string;
      worker: string;
    }
    const log = (line: Log) => {
      console[line.method](`[${line.worker}] ${line.message}`);
    };
    let lastId = 0;
    const buildUrl = (path: string, baseUrl: URL) => {
      const url = new URL(baseUrl);
      url.pathname = path;
      url.searchParams.set("stack", stack.name);
      url.searchParams.set("stage", stack.stage);
      return url;
    };
    return TestLogger.of({
      run: Effect.fn(function* (url) {
        const socketUrl = buildUrl("/__alchemy/tail", url);
        socketUrl.protocol = url.protocol === "https:" ? "wss" : "ws";
        const socket = yield* Socket.makeWebSocket(socketUrl.toString(), {
          openTimeout: "500 millis",
        });
        console.log("[test logger] socket", socketUrl.toString());
        yield* Effect.addFinalizer(() =>
          http.get(buildUrl("/__alchemy/flush", url)).pipe(
            Effect.flatMap((res) => res.json),
            Effect.map(cast<any, Array<Log>>),
            Effect.tap((res) =>
              Effect.sync(() =>
                console.error(
                  "[test logger] flush",
                  res.filter((row) => row.id > lastId),
                ),
              ),
            ),
            Effect.tapError((err) =>
              Effect.sync(() =>
                console.error("[test logger] flush error", err),
              ),
            ),
            Effect.ignore,
          ),
        );
        const write = yield* socket.writer;
        yield* socket.runString((rawLine) => {
          const line = JSON.parse(rawLine) as Log;
          console.error("[test logger] line", line);
          lastId = line.id;
          return write(JSON.stringify({ id: line.id }));
        });
      }, Effect.provide(context)),
    });
  });
