/**
 * Construction-time capture of embedded SQL migrations. Kept apart from
 * `Embedded.ts` so a runtime bundle that only applies migrations never
 * reaches the deploy-time file readers.
 *
 * @internal
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ALCHEMY_DEFAULT_TABLE } from "./AlchemyFormat.ts";
import {
  SqlMigrationsRuntime,
  type SqlMigrationSnapshot,
  type SqlMigrationsExport,
} from "./Embedded.ts";
import { MigrationError } from "./Format.ts";

/** A migrations directory, optionally with a custom bookkeeping table. */
export type SqlMigrationsInput =
  | string
  | {
      /** Directory relative to the directory where Alchemy runs. */
      readonly dir: string;
      /** Applied-migrations table. Defaults to `__alchemy_migrations`. */
      readonly table?: string;
    };

/** The hosting Worker a snapshot is exported onto during construction. */
export interface SqlMigrationsHost {
  readonly export: (name: string, value: SqlMigrationsExport) => Effect.Effect<void>;
}

/**
 * Capture files during construction and export them onto the hosting
 * Worker; at runtime, resolve only the records embedded in the bundle.
 */
export const captureSqlMigrations = Effect.fn("SqlMigrations.capture")(function* <R>(
  input: SqlMigrationsInput,
  host: Effect.Effect<SqlMigrationsHost, never, R>,
) {
  const { dir, table = ALCHEMY_DEFAULT_TABLE } = typeof input === "string" ? { dir: input } : input;
  const key = `alchemy:sql-migrations:${JSON.stringify([dir, table])}`;
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const { readMigrationRecords } = yield* Effect.promise(() => import("./Records.ts"));
    const snapshot: SqlMigrationSnapshot = {
      _tag: "Cloudflare.SqlMigrations",
      table,
      records: yield* readMigrationRecords(dir).pipe(Effect.orDie),
    };
    yield* (yield* host).export(key, { kind: "sqlMigrations", snapshot });
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
