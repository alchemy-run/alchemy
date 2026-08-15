import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

/**
 * The applied-migrations table format. Formats are per (tool, target) pair,
 * not per tool — e.g. a Prisma user on Neon has `_prisma_migrations`, while a
 * Prisma user on D1 has wrangler's `d1_migrations` (Prisma's own D1 guidance
 * is `prisma migrate diff` → SQL files → `wrangler d1 migrations apply`).
 *
 * - `drizzle`  — `__drizzle_migrations` (+ `drizzle` schema on Postgres),
 *   bookkeeping delegated to drizzle-orm's own proxy migrators.
 * - `prisma`   — `_prisma_migrations`, applied exclusively via the prisma CLI
 *   (`prisma migrate deploy`); Alchemy never writes Prisma's rows itself.
 * - `wrangler` — `d1_migrations` with wrangler's real column shape, so
 *   `wrangler d1 migrations list` works against an Alchemy-managed database.
 * - `alchemy`  — `__alchemy_migrations`: drizzle's column shape under a
 *   neutral name, the default when no other format is detected.
 */
export type MigrationFormatTag = "drizzle" | "prisma" | "wrangler" | "alchemy";

export type MigrationDialect = "postgres" | "mysql" | "sqlite";

/**
 * A single migration read from disk, normalized across directory layouts.
 */
export interface MigrationRecord {
  /**
   * The bookkeeping key used for applied-detection. Layout-dependent: the
   * directory name for drizzle-layout dirs (`20260721033159_init`), the
   * relative file path for flat dirs (`0001_users.sql`).
   */
  name: string;
  /** sha256 hex of the raw file content. */
  hash: string;
  /**
   * Millis derived from a 14-digit `YYYYMMDDHHMMSS` prefix when present
   * (drizzle records this as `created_at`).
   */
  createdAtMillis: number | undefined;
  /** Raw file content. */
  sql: string;
  /** Individual statements (split on `--> statement-breakpoint`). */
  statements: string[];
}

/**
 * The minimal query surface a migration format needs from its target
 * database. Each database resource adapts its native access path (the D1
 * HTTP API, a `pg.Client` over a Planetscale temp role, a `mysql2`
 * connection, the local workerd D1 tunnel) into this shape once.
 */
export interface SqlExecutor {
  readonly dialect: MigrationDialect;
  /**
   * Run a single query and return its rows as objects. `params` bind as
   * `?`/`$n` placeholders; adapters without native parameter support inline
   * them as SQL literals (see `inlineSqlParams`).
   */
  readonly query: (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<Array<Record<string, unknown>>, MigrationError>;
  /**
   * Execute one or more statements as a unit — a transaction where the
   * target supports one (pg/mysql), a single batched query on D1 (which has
   * no transactions over HTTP).
   */
  readonly batch: (
    statements: ReadonlyArray<string>,
  ) => Effect.Effect<void, MigrationError>;
}

/** A migration failed to read, resolve, or apply. */
export class MigrationError extends Data.TaggedError("MigrationError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * The resolved migration format contradicts the format stamped in state.
 * Converging would start a second bookkeeping table beside the first and
 * replay already-applied migrations into a live database, so the plan fails
 * instead (same doctrine as `providerMode` mismatches).
 */
export class MigrationFormatMismatchError extends Data.TaggedError(
  "MigrationFormatMismatchError",
)<{
  stamped: MigrationFormatTag;
  requested: MigrationFormatTag;
  message: string;
}> {}

/**
 * The migrations directory uses drizzle-kit's pre-v1 layout
 * (`meta/_journal.json`). drizzle-orm's own migrator refuses these; the fix
 * is upstream: `drizzle-kit up`.
 */
export class DrizzleV0LayoutError extends Data.TaggedError(
  "DrizzleV0LayoutError",
)<{
  dir: string;
  message: string;
}> {}

/**
 * The resolved format cannot apply against this target — e.g. `prisma`
 * bookkeeping is only ever written by the prisma CLI, which needs a
 * connection string the target (D1) cannot provide.
 */
export class MigrationFormatUnsupportedError extends Data.TaggedError(
  "MigrationFormatUnsupportedError",
)<{
  format: MigrationFormatTag;
  message: string;
}> {}

/**
 * A row recorded in the applied-migrations table matches no local migration
 * file. Raised during legacy-table upgrades — it means migrations were
 * applied to the database that this checkout does not have, and guessing
 * would corrupt history (mirrors drizzle's own `upgradeIfNeeded` behavior).
 */
export class MigrationHistoryConflictError extends Data.TaggedError(
  "MigrationHistoryConflictError",
)<{
  table: string;
  unmatched: ReadonlyArray<string>;
  message: string;
}> {}

export type MigrationApplyError =
  | MigrationError
  | MigrationFormatUnsupportedError
  | MigrationHistoryConflictError;
