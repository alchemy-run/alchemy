import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ALCHEMY_DEFAULT_TABLE } from "../../SQL/Migrations/AlchemyFormat.ts";
import { MigrationError } from "../../SQL/Migrations/Format.ts";
import {
  SqlMigrationsRuntime,
  type SqlMigrationSnapshot,
  type SqlMigrationsExport,
} from "./SqlMigrationsRuntime.ts";
import { Worker } from "./Worker.ts";

export type { SqlMigrationSnapshot } from "./SqlMigrationsRuntime.ts";

/** A migrations directory, optionally with a custom bookkeeping table. */
export type SqlMigrationsInput =
  | string
  | {
      /** Directory relative to the directory where Alchemy runs. */
      readonly dir: string;
      /** Applied-migrations table. Defaults to `__alchemy_migrations`. */
      readonly table?: string;
    };

/**
 * Read SQL migrations during construction and carry them into a Durable
 * Object without importing `.sql` files or generated `migrations.js`.
 *
 * Files are ordered and hashed using Alchemy's shared SQL migration format.
 * Flat SQL files and modern drizzle-kit migration directories are supported.
 * Paths are relative to the directory where Alchemy runs, not this module.
 * The records are embedded in the Worker JavaScript bundle, so they do not
 * consume environment-variable bindings. The runtime never reads the directory.
 * Missing directories and unsupported layouts fail construction.
 *
 * ### Drizzle Durable Objects
 * **Example:** Capture SQL in the outer Effect and migrate on activation
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Drizzle from "alchemy/Drizzle/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import { relations, users } from "./schema.ts";
 *
 * export class Users extends Cloudflare.DurableObject<Users>()(
 *   "Users",
 *   Effect.gen(function* () {
 *     const migrations = yield* Cloudflare.SqlMigrations("./drizzle");
 *     return Effect.gen(function* () {
 *       const db = yield* Drizzle.DurableObject({ migrations, relations });
 *       return { list: () => db.select().from(users) };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * ### Custom Bookkeeping Table
 * **Example:** Use the same table on every activation
 * ```typescript
 * const migrations = yield* Cloudflare.SqlMigrations({
 *   dir: "./drizzle",
 *   table: "app_migrations",
 * });
 * ```
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 */
export const SqlMigrations = Effect.fn("Cloudflare.SqlMigrations")(function* (
  input: SqlMigrationsInput,
) {
  const { dir, table = ALCHEMY_DEFAULT_TABLE } =
    typeof input === "string" ? { dir: input } : input;
  const key = `alchemy:sql-migrations:${JSON.stringify([dir, table])}`;
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const { readMigrationRecords } = yield* Effect.promise(
      () => import("../../SQL/Migrations/Records.ts"),
    );
    const snapshot: SqlMigrationSnapshot = {
      _tag: "Cloudflare.SqlMigrations",
      table,
      records: yield* readMigrationRecords(dir).pipe(Effect.orDie),
    };
    yield* (yield* Worker).export(key, {
      kind: "sqlMigrations",
      snapshot,
    } satisfies SqlMigrationsExport);
    return snapshot;
  }
  const bundles = yield* Effect.serviceOption(SqlMigrationsRuntime);
  const snapshot = Option.isSome(bundles) ? bundles.value[key] : undefined;
  if (snapshot === undefined) {
    return yield* Effect.die(
      new MigrationError({
        message: `SQL migrations for ${dir} were not captured during construction. Call SqlMigrations in the outer Durable Object Effect.`,
      }),
    );
  }
  return snapshot;
});
