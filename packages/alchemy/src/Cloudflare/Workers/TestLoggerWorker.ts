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
