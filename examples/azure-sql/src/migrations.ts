import * as MssqlMigrator from "@effect/sql-mssql/MssqlMigrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The schema, as ordered migrations. The migrator records each applied
 * migration in `effect_sql_migrations` and runs only the new ones, so a
 * migration runs once per database.
 */
export const migrations = MssqlMigrator.fromRecord({
  "0001_create_todos": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE todos (
        id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        title NVARCHAR(200) NOT NULL,
        done BIT NOT NULL DEFAULT 0,
        created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
      )
    `;
  }),
  "0002_index_todos_created_at": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE INDEX todos_created_at ON todos (created_at)`;
  }),
});

/** Apply the pending migrations. Returns the ones it applied. */
export const migrate = MssqlMigrator.run({ loader: migrations });
