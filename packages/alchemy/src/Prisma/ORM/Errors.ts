// Runtime error taxonomy for the prisma-next Effect client. Worker-safe:
// imports nothing beyond effect, and detects prisma-next's error shapes
// structurally (via their stable `kind` / `code` / `sqlState` discriminants)
// so this module never has to value-import the optional peer.
//
// Granularity policy: a dedicated tag wherever the discriminant is STABLE
// and handling genuinely branches — the SQL-standard integrity-violation
// SQLSTATEs (23xxx) and prisma-next's error categories (`ORM.*`,
// `RUNTIME.*`, ...). Individual codes stay a typed `code` field rather than
// one class per code: the code set churns per RC, while categories and
// SQLSTATEs do not.
import * as Data from "effect/Data";

/**
 * prisma-next structured error codes observed in 8.0.0-rc.1 — an OPEN union
 * (`string` stays assignable) so new RC codes never break, while known ones
 * autocomplete.
 */
export type PrismaErrorCode =
  | "ORM.TABLE_UNKNOWN"
  | "ORM.COLUMN_UNKNOWN"
  | "ORM.RELATION_UNKNOWN"
  | "ORM.INCLUDE_INVALID"
  | "ORM.AGGREGATE_UNSUPPORTED"
  | "ORM.MUTATION_ROW_MISSING"
  | "ORM.CAPABILITY_MISSING"
  | "RUNTIME.ENCODE_FAILED"
  | "RUNTIME.DECODE_FAILED"
  | "RUNTIME.ABORTED"
  | "RUNTIME.CODEC_MISSING"
  | "RUNTIME.PREPARE_UNUSED_PARAM"
  | "RUNTIME.PREPARE_BIND_ON_ADHOC"
  | "RUNTIME.TRANSACTION_CLOSED"
  | "RUNTIME.TRANSACTION_COMMIT_FAILED"
  | "RUNTIME.TRANSACTION_ROLLBACK_FAILED"
  | "RUNTIME.BINDING_INVALID"
  | "RUNTIME.BINDING_MISSING"
  | "BUDGET.ROWS_EXCEEDED"
  | "DRIVER.NOT_CONNECTED"
  | "DRIVER.ALREADY_CONNECTED"
  | "DRIVER.PREPARE_FAILED"
  | "CONTRACT.MARKER_MISSING"
  | "CONTRACT.MARKER_MISMATCH"
  | "CONTRACT.VERIFY_FAILED"
  | (string & {});

interface QueryErrorFields {
  message: string;
  sqlState?: string | undefined;
  constraint?: string | undefined;
  table?: string | undefined;
  column?: string | undefined;
  detail?: string | undefined;
  cause: unknown;
}

// ── integrity violations (SQL-standard SQLSTATE class 23) ─────────────
// The driver normalizes target codes onto SQLSTATE, so these tags are
// stable across databases and RCs.

/**
 * Unique or primary-key conflict (SQLSTATE `23505`) — the "email already
 * registered" case:
 *
 * ```typescript
 * Effect.catchTag("Prisma.PrismaUniqueViolationError", () =>
 *   Effect.succeed("already registered"),
 * )
 * ```
 */
export class PrismaUniqueViolationError extends Data.TaggedError(
  "Prisma.PrismaUniqueViolationError",
)<QueryErrorFields> {}

/** Foreign-key violation (SQLSTATE `23503`) — a referenced row is missing. */
export class PrismaForeignKeyViolationError extends Data.TaggedError(
  "Prisma.PrismaForeignKeyViolationError",
)<QueryErrorFields> {}

/** NOT NULL violation (SQLSTATE `23502`). */
export class PrismaNotNullViolationError extends Data.TaggedError(
  "Prisma.PrismaNotNullViolationError",
)<QueryErrorFields> {}

/** CHECK constraint violation (SQLSTATE `23514`). */
export class PrismaCheckViolationError extends Data.TaggedError(
  "Prisma.PrismaCheckViolationError",
)<QueryErrorFields> {}

/** Every integrity-constraint tag (SQLSTATE class 23). */
export type PrismaConstraintViolationError =
  | PrismaUniqueViolationError
  | PrismaForeignKeyViolationError
  | PrismaNotNullViolationError
  | PrismaCheckViolationError;

// ── other SQL / connection failures ───────────────────────────────────

/**
 * Any other SQL statement failure (syntax, permissions, serialization,
 * ...). `sqlState` carries the driver-normalized SQLSTATE for finer
 * refinement.
 */
export class PrismaQueryError extends Data.TaggedError(
  "Prisma.PrismaQueryError",
)<QueryErrorFields> {}

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

// ── prisma-next pipeline categories ───────────────────────────────────

/**
 * ORM-lane misuse or validation failure (`ORM.*` codes: unknown
 * table/column/relation, invalid include, unsupported aggregate, ...).
 * Almost always a programming bug — don't retry.
 */
export class PrismaOrmError extends Data.TaggedError("Prisma.PrismaOrmError")<{
  code: PrismaErrorCode;
  message: string;
  cause: unknown;
}> {}

/**
 * Execution-pipeline failure (`RUNTIME.*`, `DRIVER.*`, `BUDGET.*`,
 * `CONTRACT.*`, `PLAN.*`, `LINT.*`, `MIGRATION.*` codes: encode/decode,
 * codec registry, transaction lifecycle, row budgets, marker
 * verification, ...). `code` pins the exact failure.
 */
export class PrismaRuntimeError extends Data.TaggedError(
  "Prisma.PrismaRuntimeError",
)<{
  code: PrismaErrorCode;
  message: string;
  cause: unknown;
}> {}

/** A failure prisma-next did not classify at all (no kind, no code). */
export class PrismaError extends Data.TaggedError("Prisma.PrismaError")<{
  code?: PrismaErrorCode | undefined;
  message: string;
  cause: unknown;
}> {}

/**
 * Deliberate transaction rollback. Yield `tx.rollback()` inside
 * `db.transaction` to abort: the transaction rolls back and this error
 * surfaces in the caller's error channel, catchable with
 * `Effect.catchTag("Prisma.PrismaRollbackError", ...)`.
 */
export class PrismaRollbackError extends Data.TaggedError(
  "Prisma.PrismaRollbackError",
)<{}> {}

/** Everything a prisma-next query can fail with. */
export type PrismaClientError =
  | PrismaConstraintViolationError
  | PrismaQueryError
  | PrismaConnectionError
  | PrismaOrmError
  | PrismaRuntimeError
  | PrismaError;

const field = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
};

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The single funnel converting prisma-next's thrown errors into the typed
 * taxonomy. Detection uses stable discriminants: `kind: 'sql_query' |
 * 'sql_connection'` on driver errors (with SQLSTATE refining the class-23
 * integrity violations onto their own tags), and the `CATEGORY.NAME`
 * structured `code` on ORM/pipeline errors.
 */
export const wrapPrismaError = (cause: unknown): PrismaClientError => {
  const kind = field(cause, "kind");
  if (kind === "sql_query") {
    const fields: QueryErrorFields = {
      message: message(cause),
      sqlState: field(cause, "sqlState"),
      constraint: field(cause, "constraint"),
      table: field(cause, "table"),
      column: field(cause, "column"),
      detail: field(cause, "detail"),
      cause,
    };
    switch (fields.sqlState) {
      case "23505":
        return new PrismaUniqueViolationError(fields);
      case "23503":
        return new PrismaForeignKeyViolationError(fields);
      case "23502":
        return new PrismaNotNullViolationError(fields);
      case "23514":
        return new PrismaCheckViolationError(fields);
      default:
        return new PrismaQueryError(fields);
    }
  }
  if (kind === "sql_connection") {
    const transient = (cause as { transient?: unknown }).transient;
    return new PrismaConnectionError({
      message: message(cause),
      transient: typeof transient === "boolean" ? transient : undefined,
      cause,
    });
  }
  const code = field(cause, "code");
  if (code !== undefined) {
    return code.startsWith("ORM.")
      ? new PrismaOrmError({ code, message: message(cause), cause })
      : new PrismaRuntimeError({ code, message: message(cause), cause });
  }
  return new PrismaError({
    code: undefined,
    message: message(cause),
    cause,
  });
};
