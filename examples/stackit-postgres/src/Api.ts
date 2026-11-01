import * as Drizzle from "@alchemy.run/drizzle/Postgres";
import * as Stackit from "@alchemy.run/stackit";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { Puller, registryFor } from "./registry.ts";
import { AppDatabase, AppUser } from "./resources.ts";
import { todos } from "./schema.ts";

const Id = Schema.String.check(Schema.isUUID());

/**
 * A todo API on a STACKIT Function, backed by PostgreSQL Flex.
 *
 * `Stackit.PostgresFlex.Connect` grants no role: connections authenticate with the database
 * user, whose password reaches the function as a revision variable. It resolves the
 * connection URL, and Drizzle opens one pool per request on it.
 *
 * - `GET /todos` lists them.
 * - `POST /todos` creates one from `{ title }`.
 * - `GET /todos/:id` reads one, or `404`.
 */
export default class Api extends Stackit.Functions.Function<Api>()(
  "Api",
  Effect.gen(function* () {
    const puller = yield* Puller;
    const registry = yield* registryFor("api");
    return {
      main: import.meta.url,
      registry,
      pullCredential: puller.pullCredentialId,
    };
  }),
  Effect.gen(function* () {
    const connect = yield* Stackit.PostgresFlex.Connect(yield* AppDatabase, yield* AppUser);
    const db = yield* Drizzle.Postgres(connect.pipe(Effect.map((info) => info.url)));

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://function");

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }
        if (url.pathname === "/todos" && request.method === "GET") {
          return yield* HttpServerResponse.json(
            yield* db.select().from(todos).orderBy(todos.title),
          );
        }
        if (url.pathname === "/todos" && request.method === "POST") {
          const input = yield* request.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Struct({ title: Schema.NonEmptyString })),
            ),
          );
          const [todo] = yield* db
            .insert(todos)
            .values({ id: crypto.randomUUID(), title: input.title })
            .returning();
          return yield* HttpServerResponse.json(todo, { status: 201 });
        }
        if (url.pathname.startsWith("/todos/") && request.method === "GET") {
          const id = yield* Schema.decodeUnknownEffect(Id)(url.pathname.slice("/todos/".length));
          const [todo] = yield* db.select().from(todos).where(eq(todos.id, id));
          return todo
            ? yield* HttpServerResponse.json(todo)
            : HttpServerResponse.text("not found", { status: 404 });
        }
        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.succeed(HttpServerResponse.text("invalid request", { status: 400 })),
        ),
        Effect.orDie,
      ),
    };
  }).pipe(Effect.provide(Stackit.PostgresFlex.ConnectHttp)),
) {}
