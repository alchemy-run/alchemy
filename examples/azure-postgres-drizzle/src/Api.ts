import * as Azure from "@alchemy.run/azure";
import * as Drizzle from "@alchemy.run/drizzle/Postgres";
import { eq, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { APP_ROLE, database } from "./database.ts";
import { migrate } from "./migrate.ts";
import { todos } from "./schema.ts";

const Id = Schema.String.check(Schema.isUUID());

/**
 * A todo API on Azure Functions (Flex Consumption) backed by Azure
 * Database for PostgreSQL, queried with Drizzle.
 *
 * The app signs in as {@link APP_ROLE}, a role that can read and write
 * rows but not change the schema. The server's host name, the database
 * name, and the role's password reach the app as app settings.
 */
export default class Api extends Azure.Functions.Function<Api>()(
  "Api",
  Effect.gen(function* () {
    // Depending on the migration output makes the app deploy after the
    // schema exists, and redeploy when it changes.
    const schemaVersion = yield* migrate;
    return {
      main: import.meta.url,
      env: { SCHEMA_VERSION: schemaVersion },
    };
  }),
  Effect.gen(function* () {
    const { server, db: appDb, appPassword } = yield* database;
    // Each Output becomes an app setting at deploy time; the returned
    // Effects read them back at runtime.
    const host = yield* server.fullyQualifiedDomainName;
    const databaseName = yield* appDb.databaseName;
    const password = yield* appPassword.text;

    const connectionString = Effect.gen(function* () {
      const hostName = yield* host;
      const name = yield* databaseName;
      const secret = yield* password;
      return Redacted.make(
        `postgresql://${APP_ROLE}:${Redacted.value(secret)}@${hostName}:5432/${name}?sslmode=require`,
      );
    });
    // One connection per request, opened on the first query.
    const db = yield* Drizzle.Postgres(connectionString);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }
        if (request.method === "GET" && url.pathname === "/health") {
          // Who the app signs in as, and whether the connection is encrypted.
          const result = yield* db.execute(sql`SELECT current_user AS username,
            (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls`);
          return yield* HttpServerResponse.json(result);
        }
        if (url.pathname === "/todos" && request.method === "GET") {
          const rows = yield* db.select().from(todos).orderBy(todos.title);
          return yield* HttpServerResponse.json(rows);
        }
        if (url.pathname === "/todos" && request.method === "POST") {
          const input = yield* request.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Struct({ id: Id, title: Schema.NonEmptyString })),
            ),
          );
          const rows = yield* db.insert(todos).values(input).returning();
          return yield* HttpServerResponse.json(rows, { status: 201 });
        }
        if (url.pathname.startsWith("/todos/")) {
          const id = yield* Schema.decodeUnknownEffect(Id)(url.pathname.slice("/todos/".length));
          if (request.method === "GET") {
            const [todo] = yield* db.select().from(todos).where(eq(todos.id, id));
            return todo
              ? yield* HttpServerResponse.json(todo)
              : HttpServerResponse.text("Not found", { status: 404 });
          }
          if (request.method === "PATCH") {
            const input = yield* request.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ done: Schema.Boolean }))),
            );
            const [todo] = yield* db.update(todos).set(input).where(eq(todos.id, id)).returning();
            return todo
              ? yield* HttpServerResponse.json(todo)
              : HttpServerResponse.text("Not found", { status: 404 });
          }
          if (request.method === "DELETE") {
            yield* db.delete(todos).where(eq(todos.id, id));
            return HttpServerResponse.empty({ status: 204 });
          }
        }
        return HttpServerResponse.text("Not found", { status: 404 });
      }).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.succeed(HttpServerResponse.text("Invalid request", { status: 400 })),
        ),
        // A database error answers 500 with its tag, e.g. while the server
        // restarts.
        Effect.catch((error) =>
          Effect.succeed(HttpServerResponse.text(error._tag, { status: 500 })),
        ),
      ),
    };
  }),
) {}
