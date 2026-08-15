import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { DrizzleV0LayoutError, type MigrationFormatTag } from "./Format.ts";
import { DRIZZLE_DIR_PATTERN } from "./Records.ts";

/**
 * The on-disk layout of a migrations directory. `flat` means plain `.sql`
 * files with no tool markers — wrangler output or hand-written SQL.
 */
export type MigrationLayout = "drizzle" | "prisma" | "flat";

/**
 * Fingerprint a migrations directory's layout.
 *
 * ⚠️ Prisma and drizzle-v1 layouts are otherwise identical — both are
 * `<14-digit-ts>_<name>/migration.sql`. Only `migration_lock.toml` (Prisma)
 * vs the per-migration `snapshot.json` (drizzle) separates them, so the
 * markers are checked first and the timestamp shape is never used alone.
 *
 * A drizzle **v0** layout (`meta/_journal.json`) fails with a typed error:
 * drizzle-orm's own migrator refuses it, and the fix (`drizzle-kit up`) is
 * upstream of Alchemy.
 */
export const detectLayout = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exists = (p: string) =>
      fs.exists(p).pipe(Effect.catch(() => Effect.succeed(false)));

    if (yield* exists(path.join(dir, "migration_lock.toml"))) {
      return "prisma" as const;
    }
    if (yield* exists(path.join(dir, "meta", "_journal.json"))) {
      return yield* new DrizzleV0LayoutError({
        dir,
        message:
          `${dir} uses drizzle-kit's pre-v1 migration layout (meta/_journal.json). ` +
          `Upgrade drizzle-kit and run "drizzle-kit up" to convert it, then redeploy.`,
      });
    }

    const entries = yield* fs
      .readDirectory(dir)
      .pipe(Effect.catch(() => Effect.succeed([] as string[])));
    for (const entry of entries) {
      if (!DRIZZLE_DIR_PATTERN.test(entry)) continue;
      if (yield* exists(path.join(dir, entry, "migration.sql"))) {
        return "drizzle" as const;
      }
    }
    return "flat" as const;
  });

/**
 * The format a freshly-detected layout maps to on a given target. A flat
 * directory has no owning tool, so the target's default applies: wrangler's
 * table on D1 (so `wrangler d1 migrations list` interoperates), Alchemy's
 * neutral table elsewhere.
 */
export const formatForLayout = (
  layout: MigrationLayout,
  dialect: "postgres" | "mysql" | "sqlite",
): MigrationFormatTag => {
  switch (layout) {
    case "drizzle":
      return "drizzle";
    case "prisma":
      return "prisma";
    case "flat":
      return dialect === "sqlite" ? "wrangler" : "alchemy";
  }
};
