import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const Pastes = Cloudflare.D1.Database("pastes-db");

const ensureSchema = (db: Cloudflare.D1.QueryDatabaseClient) =>
  db.exec(
    "CREATE TABLE IF NOT EXISTS pastes (id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL)",
  );

export default class Api extends Cloudflare.Worker<Api>()(
  "pastebin-api",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(Pastes);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "GET" && url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && url.pathname === "/pastes") {
          const body = (yield* request.json) as { content?: unknown };
          if (typeof body.content !== "string") {
            return yield* HttpServerResponse.json(
              { error: "invalid_content" },
              { status: 400 },
            );
          }
          const id = yield* Effect.sync(() =>
            crypto.randomUUID().replaceAll("-", "").slice(0, 12),
          );
          const createdAt = yield* Effect.sync(() => new Date().toISOString());
          yield* ensureSchema(db);
          yield* db
            .prepare(
              "INSERT INTO pastes (id, content, created_at) VALUES (?, ?, ?)",
            )
            .bind(id, body.content, createdAt)
            .run();
          const host = request.headers["host"] ?? "";
          return yield* HttpServerResponse.json(
            { id, url: `https://${host}/pastes/${id}` },
            { status: 201 },
          );
        }

        const match = url.pathname.match(/^\/pastes\/([A-Za-z0-9_-]+)$/);
        if (request.method === "GET" && match) {
          yield* ensureSchema(db);
          const row = yield* db
            .prepare(
              "SELECT id, content, created_at FROM pastes WHERE id = ?",
            )
            .bind(match[1])
            .first<{ id: string; content: string; created_at: string }>();
          if (row === null) {
            return yield* HttpServerResponse.json(
              { error: "not_found" },
              { status: 404 },
            );
          }
          return yield* HttpServerResponse.json({
            id: row.id,
            content: row.content,
            createdAt: row.created_at,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "not_found" },
          { status: 404 },
        );
      }),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}
