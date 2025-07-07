import { type Config, createClient } from "@libsql/client/node";
import type { Scope } from "alchemy";
import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql/driver-core";
import { drizzle } from "drizzle-orm/libsql/node";
import { BaseSQLiteStateStore } from "./base";
import { migrations } from "./internal/migrations";
import * as schema from "./internal/schema";

interface LibSQLStateStoreOptions extends Config {}

export class LibSQLStateStore extends BaseSQLiteStateStore {
  constructor(
    scope: Scope,
    options: LibSQLStateStoreOptions = {
      url: `file:${process.env.ALCHEMY_STATE_FILE ?? ".alchemy/state.sqlite"}`,
    }
  ) {
    super(scope, {
      create: async () => {
        const db = drizzle(createClient(options), {
          schema,
        });
        await migrate(db);
        return db;
      },
    });
  }
}

// Copied from https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/libsql/migrator.ts
async function migrate(db: LibSQLDatabase<typeof schema>) {
  const migrationsTable = "__drizzle_migrations";

  const migrationTableCreate = sql`
		CREATE TABLE IF NOT EXISTS ${sql.identifier(migrationsTable)} (
			id SERIAL PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric
		)
	`;
  // @ts-expect-error - internal drizzle property
  await db.session.run(migrationTableCreate);

  const dbMigrations = await db.values<[number, string, string]>(
    sql`SELECT id, hash, created_at FROM ${sql.identifier(migrationsTable)} ORDER BY created_at DESC LIMIT 1`
  );

  const lastDbMigration = dbMigrations[0] ?? undefined;

  const statementToBatch = [];

  for (const migration of migrations) {
    if (
      !lastDbMigration ||
      // biome-ignore lint/style/noNonNullAssertion: copied from drizzle
      Number(lastDbMigration[2])! < migration.folderMillis
    ) {
      for (const stmt of migration.sql) {
        statementToBatch.push(db.run(sql.raw(stmt)));
      }

      statementToBatch.push(
        db.run(
          sql`INSERT INTO ${sql.identifier(
            migrationsTable
          )} ("hash", "created_at") VALUES(${migration.hash}, ${migration.folderMillis})`
        )
      );
    }
  }

  // @ts-expect-error - internal drizzle property
  await db.session.migrate(statementToBatch);
}
