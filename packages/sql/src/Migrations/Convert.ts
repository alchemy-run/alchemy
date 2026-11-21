import * as Effect from "effect/Effect";
import {
  MigrationError,
  MigrationHistoryConflictError,
  type MigrationRecord,
  type SqlExecutor,
} from "./Format.ts";
import { classifyTable, tableColumns } from "./Introspect.ts";
import {
  bookkeepingColumns,
  quoteIdentifier,
  scalarText,
  sqlLiteral,
  timestampPrefixMillis,
} from "./Utils.ts";

/**
 * A row of applied history harvested from a foreign migration tool's table,
 * normalized for insertion into `__alchemy_migrations`.
 */
export interface ConvertedRow {
  name: string;
  hash: string | undefined;
  createdAtMillis: number | undefined;
  appliedAt: string | undefined;
}

export interface ForeignHistory {
  /** Which tool's bookkeeping this history came from. */
  tool: "drizzle" | "prisma" | "wrangler" | "legacy-alchemy";
  /** Display name of the source table (schema-qualified where relevant). */
  source: string;
  rows: ConvertedRow[];
}

/**
 * Normalize a timestamp-ish column value for re-insertion as a SQL
 * literal. Drivers differ: pg hands back JS Dates (whose default
 * stringification pg itself cannot parse — "GMT-0700 (…)"), sqlite hands
 * back strings.
 */
export const toTimestampString = (value: unknown): string | undefined =>
  value === null || value === undefined
    ? undefined
    : value instanceof Date
      ? value.toISOString()
      : scalarText(value);

const qualify = (table: string, dialect: SqlExecutor["dialect"], schema?: string) =>
  schema
    ? `${quoteIdentifier(schema, dialect)}.${quoteIdentifier(table, dialect)}`
    : quoteIdentifier(table, dialect);

/**
 * Discover applied-migration history left behind by the tool a user is
 * migrating FROM — drizzle-kit, Prisma, or wrangler — so it can be copied
 * into Alchemy's own table once. This is a ONE-WAY migration: the foreign
 * table is read but never written or dropped (it is simply frozen), and
 * from that point on Alchemy's table is the only bookkeeping.
 *
 * Sources probed, most-specific first:
 * - drizzle: `__drizzle_migrations` (in the `drizzle` schema on Postgres) —
 *   drizzle's columns are Alchemy's columns, so rows copy verbatim. A
 *   drizzle-orm 0.x table records no name: each row is matched to a local
 *   record as drizzle-orm 1.0 upgrades that table (see `readDrizzleV0Rows`).
 * - prisma: `_prisma_migrations` — `migration_name`/`checksum` map to
 *   `name`/`hash` (both are sha256 of `migration.sql`). A failed migration
 *   (`finished_at IS NULL`, not rolled back) aborts the conversion: it must
 *   be repaired with `prisma migrate resolve` first. Rolled-back rows are
 *   skipped.
 * - wrangler (sqlite): `d1_migrations` in wrangler's shape — names carry
 *   over; hashes backfill from local records.
 */
export const findForeignHistory = (options: {
  executor: SqlExecutor;
  /** The resolved Alchemy table — a source with this name is not foreign. */
  table: string;
  /** The local records, which name a drizzle-orm 0.x table's rows. */
  records: ReadonlyArray<MigrationRecord>;
}): Effect.Effect<ForeignHistory | undefined, MigrationError> =>
  Effect.gen(function* () {
    const { executor, table, records } = options;
    const dialect = executor.dialect;

    // drizzle
    const drizzleSchema = dialect === "postgres" ? "drizzle" : undefined;
    if (table !== "__drizzle_migrations") {
      const columns = yield* tableColumns(executor, "__drizzle_migrations", drizzleSchema);
      const drizzleShape = classifyTable(columns);
      if (drizzleShape === "drizzle-v0") {
        const source = drizzleSchema
          ? `${drizzleSchema}.__drizzle_migrations`
          : "__drizzle_migrations";
        return {
          tool: "drizzle" as const,
          source,
          rows: yield* readDrizzleV0Rows({
            executor,
            from: qualify("__drizzle_migrations", dialect, drizzleSchema),
            records,
          }),
        };
      }
      if (drizzleShape === "drizzle-shaped") {
        const rows = yield* executor.query(
          `SELECT hash, created_at, name, applied_at FROM ${qualify("__drizzle_migrations", dialect, drizzleSchema)} ORDER BY id;`,
        );
        return {
          tool: "drizzle" as const,
          source: drizzleSchema ? `${drizzleSchema}.__drizzle_migrations` : "__drizzle_migrations",
          rows: rows
            .filter((row) => row.name !== null && row.name !== undefined)
            .map((row) => ({
              name: String(row.name),
              hash: row.hash === null || row.hash === undefined ? undefined : scalarText(row.hash),
              createdAtMillis:
                row.created_at === null || row.created_at === undefined
                  ? undefined
                  : Number(row.created_at),
              appliedAt: toTimestampString(row.applied_at),
            })),
        };
      }
    }

    // prisma
    if (table !== "_prisma_migrations") {
      const columns = yield* tableColumns(executor, "_prisma_migrations");
      const names = new Set(columns.map((c) => c.name));
      if (names.has("migration_name") && names.has("checksum")) {
        const rows = yield* executor.query(
          `SELECT migration_name, checksum, started_at, finished_at, rolled_back_at FROM ${quoteIdentifier("_prisma_migrations", dialect)};`,
        );
        const failed = rows.filter(
          (row) =>
            (row.finished_at === null || row.finished_at === undefined) &&
            (row.rolled_back_at === null || row.rolled_back_at === undefined),
        );
        if (failed.length > 0) {
          return yield* new MigrationError({
            message:
              `_prisma_migrations records ${failed.length} failed migration(s) ` +
              `(${failed.map((r) => String(r.migration_name)).join(", ")}). ` +
              `Repair them with "prisma migrate resolve" before migrating this ` +
              `database's bookkeeping to Alchemy.`,
          });
        }
        return {
          tool: "prisma" as const,
          source: "_prisma_migrations",
          rows: rows
            .filter(
              (row) =>
                row.finished_at !== null &&
                row.finished_at !== undefined &&
                (row.rolled_back_at === null || row.rolled_back_at === undefined),
            )
            .map((row) => ({
              name: String(row.migration_name),
              hash:
                row.checksum === null || row.checksum === undefined
                  ? undefined
                  : scalarText(row.checksum),
              createdAtMillis: timestampPrefixMillis(String(row.migration_name)),
              appliedAt: toTimestampString(row.finished_at),
            })),
        };
      }
    }

    // wrangler / pre-registry Alchemy on D1 (which shared the
    // d1_migrations name — covers state-lost adoption of old deploys)
    if (dialect === "sqlite" && table !== "d1_migrations") {
      const shape = classifyTable(yield* tableColumns(executor, "d1_migrations"));
      if (shape === "wrangler" || shape === "legacy-alchemy" || shape === "legacy-2col") {
        const nameExpr = shape === "legacy-2col" ? "id" : "name";
        const rows = yield* executor.query(
          `SELECT ${nameExpr} AS name, applied_at FROM ${quoteIdentifier("d1_migrations", dialect)} ORDER BY id;`,
        );
        return {
          tool: shape === "wrangler" ? ("wrangler" as const) : ("legacy-alchemy" as const),
          source: "d1_migrations",
          rows: rows
            .filter((row) => row.name !== null && row.name !== undefined)
            .map((row) => ({
              name: String(row.name),
              hash: undefined,
              createdAtMillis: timestampPrefixMillis(String(row.name)),
              appliedAt: toTimestampString(row.applied_at),
            })),
        };
      }
    }

    return undefined;
  });

/**
 * Read a drizzle-orm 0.x history table (`id`, `hash`, `created_at`, no
 * name) and name each row by the rule drizzle-orm 1.0 uses when it upgrades
 * that table (`up-migrations/sqlite.ts`, `upToV1`): `created_at` truncated
 * to the second picks the local record with that timestamp; several share
 * it, the hash decides; none has it, the hash alone does. A row nothing
 * matches is labelled `[id: <id>, created_at: <created_at>]`, so `matchForeignRows`
 * reports it as history this checkout doesn't have.
 */
export const readDrizzleV0Rows = (options: {
  executor: SqlExecutor;
  /** The table, already quoted (and schema-qualified where relevant). */
  from: string;
  records: ReadonlyArray<MigrationRecord>;
}): Effect.Effect<ConvertedRow[], MigrationError> =>
  Effect.gen(function* () {
    const { executor, from, records } = options;
    const rows = yield* executor.query(`SELECT id, hash, created_at FROM ${from} ORDER BY id;`);
    const bySecond = new Map<number, MigrationRecord[]>();
    for (const record of records) {
      if (record.createdAtMillis === undefined) continue;
      bySecond.set(record.createdAtMillis, [
        ...(bySecond.get(record.createdAtMillis) ?? []),
        record,
      ]);
    }
    return rows.map((row) => {
      const hash = row.hash === null || row.hash === undefined ? undefined : scalarText(row.hash);
      const createdAt =
        row.created_at === null || row.created_at === undefined
          ? undefined
          : Number(scalarText(row.created_at));
      const candidates =
        createdAt === undefined ? undefined : bySecond.get(Math.floor(createdAt / 1000) * 1000);
      const record =
        candidates?.length === 1
          ? candidates[0]
          : (candidates ?? records).find((r) => hash !== undefined && r.hash === hash);
      return {
        name: record?.name ?? `[id: ${scalarText(row.id)}, created_at: ${createdAt ?? "null"}]`,
        hash,
        createdAtMillis: createdAt,
        appliedAt: undefined,
      };
    });
  });

/**
 * Validate foreign history against the local migrations directory and fill
 * in missing hashes. Every foreign row must match a local record by name
 * (or by the `<dir>/migration.sql` ⇄ `<dir>` aliasing between flat and
 * directory layouts) — an unmatched row means migrations were applied that
 * this checkout does not have.
 *
 * A row that names a file (wrangler's, or pre-registry Alchemy's) also
 * matches the record `drizzle-kit up` made of that file (see
 * {@link renamedByDrizzleKitUp}), taking that record's name.
 */
export const matchForeignRows = (options: {
  history: ForeignHistory;
  records: ReadonlyArray<MigrationRecord>;
}): Effect.Effect<ConvertedRow[], MigrationHistoryConflictError> =>
  Effect.gen(function* () {
    const { history, records } = options;
    const byName = new Map(records.map((r) => [r.name, r]));
    const byAlias = new Map(
      records.flatMap((r) => [
        [`${r.name}/migration.sql`, r] as const,
        [r.name.replace(/\/migration\.sql$/, ""), r] as const,
      ]),
    );
    const direct = history.rows.map((row) => byName.get(row.name) ?? byAlias.get(row.name));
    const renamed =
      history.tool === "wrangler" || history.tool === "legacy-alchemy"
        ? renamedByDrizzleKitUp(
            history.rows.filter((_, i) => direct[i] === undefined),
            records.filter((record) => !direct.includes(record)),
          )
        : new Map<ConvertedRow, MigrationRecord>();
    const matched: ConvertedRow[] = [];
    const unmatched: string[] = [];
    for (const [i, row] of history.rows.entries()) {
      const record = direct[i];
      const renamedTo = renamed.get(row);
      if (record) {
        matched.push({
          ...row,
          hash: row.hash ?? record.hash,
          createdAtMillis: row.createdAtMillis ?? record.createdAtMillis,
        });
      } else if (renamedTo) {
        matched.push({
          ...row,
          name: renamedTo.name,
          hash: renamedTo.hash,
          createdAtMillis: row.createdAtMillis ?? renamedTo.createdAtMillis,
        });
      } else {
        unmatched.push(row.name);
      }
    }
    if (unmatched.length > 0) {
      return yield* new MigrationHistoryConflictError({
        table: history.source,
        unmatched,
        message:
          `While migrating ${history.tool} bookkeeping (${history.source}) to ` +
          `Alchemy, ${unmatched.length} recorded migration(s) match no local ` +
          `file: ${unmatched.join(", ")}. Migrations were applied to this ` +
          `database that are missing from the local environment.`,
      });
    }
    return matched;
  });

/**
 * Pair rows that name files with the records `drizzle-kit up` made of them.
 * drizzle-kit 1.0 moves a flat `<idx>_<rest>.sql` to
 * `<when>_<rest>/migration.sql`, its contents byte for byte and in the same
 * order (`planFoldersV3` and `applyFoldersV3` in drizzle-kit's CLI), while
 * wrangler's `d1_migrations` (and pre-registry Alchemy's) keeps the old file
 * names, applied in name order. So the unmatched rows, in the order they
 * were applied, pair with the unmatched renamed records, in timestamp
 * order, one for one: the n-th row with the n-th record, which must share
 * its `<rest>`. The records after the last pair are pending. Any pair that
 * disagrees pairs nothing, so a row is never matched by a guess.
 */
const renamedByDrizzleKitUp = (
  rows: ReadonlyArray<ConvertedRow>,
  records: ReadonlyArray<MigrationRecord>,
): Map<ConvertedRow, MigrationRecord> => {
  const restOfRow = (row: ConvertedRow) => /^\d+_(.+)\.sql$/.exec(row.name)?.[1];
  const restOfRecord = (record: MigrationRecord) => /^\d{14}_(.+)$/.exec(record.name)?.[1];
  const renamed = records
    .filter((record) => restOfRecord(record) !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
  const paired = new Map<ConvertedRow, MigrationRecord>();
  for (const [i, row] of rows.entries()) {
    const record = renamed[i];
    const rest = restOfRow(row);
    if (record === undefined || rest === undefined || rest !== restOfRecord(record)) {
      return new Map();
    }
    paired.set(row, record);
  }
  return paired;
};

/** Render an INSERT for a converted history row into Alchemy's table. */
export const convertedRowInsertSql = (
  table: string,
  dialect: SqlExecutor["dialect"],
  row: ConvertedRow,
): string =>
  `INSERT INTO ${quoteIdentifier(table, dialect)} (${bookkeepingColumns(dialect, "hash", "created_at", "name", "applied_at")}) VALUES (${sqlLiteral(row.hash ?? "", dialect)}, ${sqlLiteral(row.createdAtMillis ?? null, dialect)}, ${sqlLiteral(row.name, dialect)}, ${sqlLiteral(row.appliedAt ?? null, dialect)});`;
