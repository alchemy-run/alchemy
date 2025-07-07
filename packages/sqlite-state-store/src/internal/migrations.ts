import { type MigrationMeta, readMigrationFiles } from "drizzle-orm/migrator";

interface Migration extends MigrationMeta {
  id: string;
}

const resolveMigrations = async (): Promise<Migration[]> => {
  return readMigrationFiles({ migrationsFolder: "drizzle" }).map((it) => ({
    ...it,
    id: it.hash,
  }));
};

export const migrations = process.env.ALCHEMY_MIGRATIONS
  ? (process.env.ALCHEMY_MIGRATIONS as unknown as Migration[])
  : await resolveMigrations();
