import * as mf from "miniflare";
import { getDefaultPersistPath } from "./miniflare/paths.ts";

export interface D1LocalMigrationOptions {
  rootDir: string;
  databaseId: string;
  migrationsTable: string;
  migrations: { id: string; sql: string }[];
}

export const applyLocalD1Migrations = async (
  options: D1LocalMigrationOptions,
) => {
  const miniflare = new mf.Miniflare({
    script: "",
    modules: true,
    defaultPersistRoot: getDefaultPersistPath(options.rootDir),
    d1Persist: true,
    d1Databases: { DB: options.databaseId },
    log: process.env.DEBUG ? new mf.Log(mf.LogLevel.DEBUG) : undefined,
  });
  try {
    await miniflare.ready;
    // TODO(sam): don't use `any` once prisma is fixed upstream
    const db: any = await miniflare.getD1Database("DB");
    const session: any = db.withSession("first-primary");
    await session
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${options.migrationsTable} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`,
      )
      .run();
    const appliedMigrations: {
      results: { name: string }[];
    } = await session
      .prepare(
        `SELECT name FROM ${options.migrationsTable} ORDER BY applied_at ASC`,
      )
      .all();
    const insertRecord = session.prepare(
      `INSERT INTO ${options.migrationsTable} (name) VALUES (?)`,
    );
    for (const migration of options.migrations) {
      if (appliedMigrations.results.some((m) => m.name === migration.id)) {
        continue;
      }
      await session.prepare(migration.sql).run();
      await insertRecord.bind(migration.id).run();
    }
  } finally {
    await miniflare.dispose();
  }
};
