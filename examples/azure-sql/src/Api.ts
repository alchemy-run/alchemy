import * as Azure from "@alchemy.run/azure";
import * as MssqlClient from "@effect/sql-mssql/MssqlClient";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { migrate } from "./migrations.ts";
import { ADMIN_LOGIN, AdminPassword, AllowAzureServices, Sql, Todos } from "./resources.ts";

/** A todo row, as the API returns it. */
export interface Todo {
  id: string;
  title: string;
  done: boolean;
  createdAt: string;
}

const Id = Schema.String.check(Schema.isUUID());
const CreateTodo = Schema.Struct({ title: Schema.NonEmptyString });
const UpdateTodo = Schema.Struct({ done: Schema.Boolean });

const json = (body: unknown, status = 200) => HttpServerResponse.json(body, { status });

/**
 * A todo API on Azure Functions (Flex Consumption) backed by an Azure SQL
 * Database.
 *
 * - `GET /todos` — every todo, oldest first.
 * - `POST /todos` — create `{ title }`, `201` with the todo.
 * - `GET /todos/:id` — one todo, `404` if there is none.
 * - `PATCH /todos/:id` — set `{ done }`, `200` with the todo.
 * - `DELETE /todos/:id` — `204`.
 * - `GET /migrations` — the migrations applied to the database.
 *
 * Each request opens its own connection pool with `@effect/sql-mssql` and
 * closes it when the response is sent. The first request on an instance
 * applies pending migrations (`./migrations.ts`) before it runs.
 *
 * A SQL error answers `503` with the error, so a caller can retry while the
 * firewall rule takes effect after the first deploy.
 */
export default class Api extends Azure.Functions.Function<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const server = yield* Sql;
    const database = yield* Todos;
    // Deploy the firewall rule with the app: the app cannot connect without it.
    yield* AllowAzureServices;

    // Each `yield*` of an Output binds it into the app settings and returns
    // an Effect that reads it back at runtime.
    const host = yield* server.fullyQualifiedDomainName;
    const databaseName = yield* database.databaseName;
    const passwordOutput = yield* AdminPassword;
    const password = yield* passwordOutput;

    const SqlLive = Layer.unwrap(
      Effect.gen(function* () {
        const resolvedHost = yield* host;
        const resolvedDatabase = yield* databaseName;
        const resolvedPassword = yield* password;
        return MssqlClient.layer({
          server: resolvedHost,
          database: resolvedDatabase,
          username: ADMIN_LOGIN,
          password: resolvedPassword,
          connectTimeout: "30 seconds",
        });
      }),
    );

    // Migrations run once per instance, before its first query. The flag
    // is set only after they succeed, so the next request retries a
    // failed run.
    const migrated = yield* Ref.make(false);
    const lock = yield* Semaphore.make(1);
    const ensureSchema = lock.withPermit(
      Effect.gen(function* () {
        if (yield* Ref.get(migrated)) return;
        yield* migrate;
        yield* Ref.set(migrated, true);
      }),
    );

    const selectTodos = (sql: SqlClient.SqlClient) =>
      sql`SELECT LOWER(CONVERT(NVARCHAR(36), id)) AS id, title, done, CONVERT(NVARCHAR(30), created_at, 127) AS createdAt FROM todos`;

    const findTodo = (id: string) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<Todo>`${selectTodos(sql)} WHERE id = ${id}`;
        return rows[0];
      });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const segments = url.pathname.split("/").filter(Boolean);

        if (request.method === "GET" && segments.length === 0) {
          return HttpServerResponse.text("ok");
        }

        yield* ensureSchema;
        const sql = yield* SqlClient.SqlClient;

        if (request.method === "GET" && url.pathname === "/migrations") {
          const rows = yield* sql<{
            id: number;
            name: string;
          }>`SELECT migration_id AS id, name FROM effect_sql_migrations ORDER BY migration_id`;
          return yield* json(rows);
        }

        if (url.pathname === "/todos" && request.method === "GET") {
          const rows = yield* sql<Todo>`${selectTodos(sql)} ORDER BY created_at, id`;
          return yield* json(rows);
        }

        if (url.pathname === "/todos" && request.method === "POST") {
          const body = yield* request.json;
          const input = yield* Schema.decodeUnknownEffect(CreateTodo)(body);
          const id = yield* Effect.sync(() => crypto.randomUUID());
          yield* sql`INSERT INTO todos (id, title) VALUES (${id}, ${input.title})`;
          const todo = yield* findTodo(id);
          return yield* json(todo, 201);
        }

        if (segments.length === 2 && segments[0] === "todos") {
          const id = yield* Schema.decodeUnknownEffect(Id)(segments[1]);
          if (request.method === "GET") {
            const todo = yield* findTodo(id);
            return todo === undefined
              ? yield* json({ error: "not found" }, 404)
              : yield* json(todo);
          }
          if (request.method === "PATCH") {
            const body = yield* request.json;
            const input = yield* Schema.decodeUnknownEffect(UpdateTodo)(body);
            yield* sql`UPDATE todos SET done = ${input.done} WHERE id = ${id}`;
            const todo = yield* findTodo(id);
            return todo === undefined
              ? yield* json({ error: "not found" }, 404)
              : yield* json(todo);
          }
          if (request.method === "DELETE") {
            yield* sql`DELETE FROM todos WHERE id = ${id}`;
            return HttpServerResponse.empty({ status: 204 });
          }
        }

        return yield* json({ error: "not found" }, 404);
      }).pipe(
        Effect.catchTag("SchemaError", (error) => json({ error: error.message }, 400)),
        // An unreadable or non-JSON body.
        Effect.catchTag("HttpServerError", (error) => json({ error: error.message }, 400)),
        // One pool per request: the layer is built for this request and
        // closed after the response.
        Effect.provide(SqlLive),
        Effect.catchCause((cause) => json({ error: Cause.pretty(cause) }, 503)),
      ),
    };
  }),
) {}
