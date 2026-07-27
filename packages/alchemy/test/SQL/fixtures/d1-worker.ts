import * as Cloudflare from "@/Cloudflare/index.ts";
import * as SQL from "@/SQL/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Sql from "effect/unstable/sql/SqlClient";
import { handleSqlRoutes } from "./routes.ts";

export const Database = Cloudflare.D1.Database("SqlD1Database");

const TABLE = "alchemy_sql_users";

const DDL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL
)`;

/**
 * Effect-native Worker driving `SQL.D1` (the raw `@effect/sql-d1` client)
 * over a bound D1 database. All routes come from the shared dialect-agnostic
 * table in `routes.ts` — D1 has no dialect extras (`@effect/sql-d1` supports
 * neither transactions nor `updateValues`).
 */
export default class SqlD1Worker extends Cloudflare.Worker<SqlD1Worker>()(
  "SqlD1Worker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const d1 = yield* Cloudflare.D1.QueryDatabase(Database);
    const sql = yield* SQL.D1(d1);
    // The same database through `SQL.D1Layer` — resolved as the generic
    // `SqlClient` service, proving the Layer wiring end-to-end.
    const layerSql = yield* Effect.gen(function* () {
      return yield* Sql.SqlClient;
    }).pipe(Effect.provide(SQL.D1Layer(d1)));

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const response = yield* handleSqlRoutes(
          { sql, layerSql, ddl: DDL, table: TABLE },
          request,
        );
        if (response !== undefined) {
          return response;
        }
        return yield* HttpServerResponse.json(
          { error: "not found" },
          { status: 404 },
        );
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: String(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}
