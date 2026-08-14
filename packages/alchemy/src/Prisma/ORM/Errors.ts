// Runtime error taxonomy for the prisma-next Effect client. Worker-safe:
// imports nothing beyond effect, and detects prisma-next's error shapes
// structurally (via their stable `kind` / `code` discriminants) so this
// module never has to value-import the optional peer.
import * as Data from "effect/Data";

/**
 * A prisma-next runtime failure that is neither a SQL query error nor a
 * connection error — ORM validation (`ORM.*` codes), plan/codec pipeline
 * failures (`RUNTIME.*` codes), or anything unrecognized. The structured
 * `code` prisma-next attaches (e.g. `ORM.INCLUDE_INVALID`,
 * `RUNTIME.DECODE_FAILED`) is surfaced when present.
 */
export class PrismaError extends Data.TaggedError("Prisma.PrismaError")<{
  code?: string | undefined;
  message: string;
  cause: unknown;
}> {}

/**
 * A SQL statement failure: syntax errors, permission failures, and
 * constraint violations. prisma-next's driver normalizes target error codes
 * onto `sqlState` (unique violations always surface as `23505`), so
 * violations are classifiable without any target-specific knowledge:
 *
 * ```typescript
 * Effect.catchTag("Prisma.PrismaQueryError", (error) =>
 *   error.isUniqueViolation
 *     ? Effect.succeed("email already registered")
 *     : Effect.fail(error),
 * )
 * ```
 */
export class PrismaQueryError extends Data.TaggedError(
  "Prisma.PrismaQueryError",
)<{
  message: string;
  sqlState?: string | undefined;
  constraint?: string | undefined;
  table?: string | undefined;
  column?: string | undefined;
  detail?: string | undefined;
  cause: unknown;
}> {
  /** SQL-standard `unique_violation` — a unique or primary-key conflict. */
  get isUniqueViolation(): boolean {
    return this.sqlState === "23505";
  }
}

/**
 * A connection-level failure (refused, reset, timed out). `transient`
 * carries the driver's own judgment of retryability:
 *
 * ```typescript
 * Effect.retry(effect, {
 *   while: (e) => e._tag === "Prisma.PrismaConnectionError" && e.transient === true,
 *   times: 3,
 * })
 * ```
 */
export class PrismaConnectionError extends Data.TaggedError(
  "Prisma.PrismaConnectionError",
)<{
  message: string;
  transient?: boolean | undefined;
  cause: unknown;
}> {}

/**
 * Deliberate transaction rollback. Yield `tx.rollback()` inside
 * {@link PostgresDatabase.transaction} to abort: the transaction rolls back
 * and this error surfaces in the caller's error channel, catchable with
 * `Effect.catchTag("Prisma.PrismaRollbackError", ...)`.
 */
export class PrismaRollbackError extends Data.TaggedError(
  "Prisma.PrismaRollbackError",
)<{}> {}

/** Everything a prisma-next query can fail with. */
export type PrismaClientError =
  | PrismaError
  | PrismaQueryError
  | PrismaConnectionError;

const field = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
};

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The single funnel converting prisma-next's thrown errors into the typed
 * taxonomy. Detection uses the stable discriminants prisma-next puts on its
 * error classes: `kind: 'sql_query' | 'sql_connection'` on driver errors,
 * and a structured `code` on ORM/runtime errors.
 */
export const wrapPrismaError = (cause: unknown): PrismaClientError => {
  const kind = field(cause, "kind");
  if (kind === "sql_query") {
    return new PrismaQueryError({
      message: message(cause),
      sqlState: field(cause, "sqlState"),
      constraint: field(cause, "constraint"),
      table: field(cause, "table"),
      column: field(cause, "column"),
      detail: field(cause, "detail"),
      cause,
    });
  }
  if (kind === "sql_connection") {
    const transient = (cause as { transient?: unknown }).transient;
    return new PrismaConnectionError({
      message: message(cause),
      transient: typeof transient === "boolean" ? transient : undefined,
      cause,
    });
  }
  return new PrismaError({
    code: field(cause, "code"),
    message: message(cause),
    cause,
  });
};
