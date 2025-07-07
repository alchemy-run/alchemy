import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";

export const migrations = process.env.ALCHEMY_MIGRATIONS
  ? (process.env.ALCHEMY_MIGRATIONS as unknown as MigrationMeta[])
  : readMigrationFiles({ migrationsFolder: "drizzle" });
