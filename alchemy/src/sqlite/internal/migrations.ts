import { type MigrationMeta, readMigrationFiles } from "drizzle-orm/migrator";
import path from "node:path";

const resolveMigrations = async (): Promise<MigrationMeta[]> => {
  return readMigrationFiles({
    migrationsFolder: path.join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "drizzle",
    ),
  });
};

// TODO(john): the idea here was that we can use `define` in a build step to pre-compile migrations
// so we don't have to worry about path resolution at runtime. However, I haven't figured out how to
// bundle this within the `alchemy` monopackage since we have unbundled code referencing bundled code.
export const migrations = process.env.ALCHEMY_MIGRATIONS
  ? (process.env.ALCHEMY_MIGRATIONS as unknown as MigrationMeta[])
  : await resolveMigrations();
