import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Hyperdrive } from "./Db.ts";
import { relations, Users } from "./schema.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
    compatibility: {
      date: "2026-03-17",
      flags: ["nodejs_compat"],
    },
  },
  Effect.gen(function* () {
    const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
    const db = yield* Drizzle.mysql(conn.connectionString, {
      relations,
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        switch (request.method) {
          case "GET": {
            if (request.url === "/") {
              const users = yield* db.select().from(Users);
              return yield* HttpServerResponse.json({ users });
            }
            const id = Number(request.url.split("/").pop());
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
            const [created] = yield* db
              .insert(Users)
              .values({
                name: crypto.randomUUID(),
                email: crypto.randomUUID(),
              })
              .$returningId();
            const user = yield* db
              .select()
              .from(Users)
              .where(eq(Users.id, created.id));
            return yield* HttpServerResponse.json({ user });
          }
          case "DELETE": {
            const id = Number(request.url.split("/").pop());
            if (Number.isNaN(id)) {
              return yield* HttpServerResponse.json(
                { error: "Invalid user ID" },
                { status: 400 },
              );
            }
            const [user] = yield* db
              .select()
              .from(Users)
              .where(eq(Users.id, id));
            yield* db.delete(Users).where(eq(Users.id, id));
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
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: String(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}
