import * as Drizzle from "alchemy/Drizzle/Postgres";
import * as Fly from "alchemy/Fly";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { relations, Users } from "./schema.ts";
import { API_PORT, Db, Site } from "./shared.ts";

/**
 * HTTP Service that binds Managed Postgres via {@link Fly.ConnectPostgres}
 * and queries through Drizzle.
 */
export default class Api extends Fly.Service<Api>()(
  "Api",
  {
    app: Site,
    main: import.meta.url,
    region: "iad",
    port: API_PORT,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    const conn = yield* Fly.ConnectPostgres(Db);
    const db = yield* Drizzle.Postgres(conn.connectionString, {
      relations,
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;
        if (path === "/health") {
          const users = yield* db.select().from(Users);
          return yield* HttpServerResponse.json({
            ok: true,
            users: users.length,
          });
        }
        switch (request.method) {
          case "GET": {
            if (path === "/" || path === "/users") {
              const users = yield* db.select().from(Users);
              return yield* HttpServerResponse.json({ users });
            }
            const id = Number(path.split("/").pop());
            if (Number.isNaN(id)) {
              return yield* HttpServerResponse.json(
                { error: "Invalid user ID" },
                { status: 400 },
              );
            }
            const user = yield* db.query.Users.findFirst({
              where: { id },
              with: { posts: true },
            });
            return yield* HttpServerResponse.json({ user });
          }
          case "POST": {
            const user = yield* db
              .insert(Users)
              .values({
                name: crypto.randomUUID(),
                email: crypto.randomUUID(),
              })
              .returning();
            return yield* HttpServerResponse.json({ user });
          }
          case "DELETE": {
            const id = Number(path.split("/").pop());
            if (Number.isNaN(id)) {
              return yield* HttpServerResponse.json(
                { error: "Invalid user ID" },
                { status: 400 },
              );
            }
            const [user] = yield* db
              .delete(Users)
              .where(eq(Users.id, id))
              .returning();
            return yield* HttpServerResponse.json({ user });
          }
          default: {
            return yield* HttpServerResponse.json(
              { error: "Method not allowed" },
              { status: 405 },
            );
          }
        }
      }).pipe(
        Effect.catch((cause: unknown) =>
          HttpServerResponse.json(
            { ok: false, error: String(cause) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Fly.ConnectPostgresHttp)),
) {}
