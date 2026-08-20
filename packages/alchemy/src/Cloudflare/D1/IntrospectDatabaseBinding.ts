import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Database } from "./Database.ts";
import {
  type DatabaseSchema,
  type DatabaseTable,
  IntrospectDatabase,
  type IntrospectDatabaseClient,
} from "./IntrospectDatabase.ts";

/**
 * Native Worker-binding implementation of {@link IntrospectDatabase}.
 *
 * @layer
 * @provides Cloudflare.D1.IntrospectDatabase
 * @product D1
 */
export const IntrospectDatabaseBinding = Layer.effect(
  IntrospectDatabase,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (database: Database) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${database}`({
          bindings: [
            {
              type: "d1",
              name: database.LogicalId,
              databaseId: database.databaseId,
            },
          ],
        });
      }

      const raw = Effect.sync(
        () => (env as Record<string, runtime.D1Database>)[database.LogicalId]!,
      );
      return { schema: introspect(raw) } satisfies IntrospectDatabaseClient;
    });
  }),
);

const quoteSqlString = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

const introspect = (
  rawEffect: Effect.Effect<runtime.D1Database>,
): Effect.Effect<DatabaseSchema> =>
  Effect.flatMap(rawEffect, (raw) =>
    Effect.promise(async () => {
      const tables = await raw
        .prepare(
          `SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`,
        )
        .all<{ name: string; type: "table" | "view"; sql: string | null }>();
      return {
        tables: await Promise.all(
          tables.results.map(async (table) => {
            const argument = quoteSqlString(table.name);
            const [columns, foreignKeys] = await Promise.all([
              raw.prepare(`PRAGMA table_xinfo(${argument})`).all<{
                name: string;
                type: string;
                notnull: number;
                dflt_value: string | null;
                pk: number;
                hidden: number;
              }>(),
              raw.prepare(`PRAGMA foreign_key_list(${argument})`).all<{
                table: string;
                from: string;
                to: string;
              }>(),
            ]);
            return {
              ...table,
              columns: columns.results.map((column) => ({
                name: column.name,
                datatype: column.type,
                defaultValue: column.dflt_value,
                primaryKey: column.pk !== 0,
                computed: column.hidden === 2 || column.hidden === 3,
                nullable: column.notnull === 0,
                foreignKeys: foreignKeys.results
                  .filter((foreignKey) => foreignKey.from === column.name)
                  .map((foreignKey) => ({
                    table: foreignKey.table,
                    column: foreignKey.to,
                  })),
              })),
            } satisfies DatabaseTable;
          }),
        ),
      };
    }),
  );
