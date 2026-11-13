/**
 * Mutants of the Export stores: each one edit a plausible bug would make to
 * the real source. The conformance suite must fail against every one; a
 * survivor is a gap in the suite (or a mutant that cannot change behaviour,
 * which belongs out of this list with the reason).
 */
export interface Mutant {
  readonly id: string;
  /** The source file, relative to `packages/domain/src/Export/`. */
  readonly file:
    | "Store.ts"
    | "SqlStore.ts"
    | "Iceberg.ts"
    | "Trino.ts"
    | "DuckDb.ts"
    | "Engine.ts"
    | "Sql.ts"
    | "Athena.ts";
  /** Text that occurs exactly once in the file. */
  readonly find: string;
  readonly replace: string;
  /** The suite that must kill it, relative to `packages/integration-tests/test/`. */
  readonly suite: string;
  /** Tags the suite needs named to run (an opt-in tier). */
  readonly tags?: ReadonlyArray<string>;
  readonly why: string;
}

const memory = "Domain/ExportStoreMemory.test.ts";
const sqlite = "Domain/ExportStoreSqlite.test.ts";
const iceberg = "DomainExport/StoreIceberg.test.ts";
// The conformance suite reads through the store's own readers; how an engine sees a table
// (the stable-name view) is the engine suite's to prove.

export const mutants: ReadonlyArray<Mutant> = [
  // ---------------------------------------------------------------- the memory store
  {
    id: "store/identity-without-route",
    file: "Store.ts",
    find: "identity.route ?? null,",
    replace: "null,",
    suite: memory,
    why: "an event delivered to one key by two routes keeps only its first row",
  },
  {
    id: "store/identity-without-key",
    file: "Store.ts",
    find: "JSON.stringify([identity.key,",
    replace: 'JSON.stringify(["",',
    suite: memory,
    why: "an event routed to two keys keeps only its first row",
  },
  {
    id: "memory/last-write-wins",
    file: "Store.ts",
    find: "if (table.has(identity)) continue;",
    replace: "",
    suite: memory,
    why: "a retry overwrites the first write's metadata",
  },
  {
    id: "memory/no-carry",
    file: "Store.ts",
    find: "source?.get(identity)?.json",
    replace: "undefined",
    suite: memory,
    why: "a rebuild forgets when rows first arrived",
  },
  {
    id: "memory/ignore-filter",
    file: "Store.ts",
    find: ".filter((json) => DomainFilter.matches(request.where, json))",
    replace: "",
    suite: memory,
    why: "reads return rows the filter excludes",
  },
  {
    id: "memory/ignore-order",
    file: "Store.ts",
    find: "request.orderBy,",
    replace: "undefined,",
    suite: memory,
    why: "reads ignore orderBy",
  },
  {
    id: "memory/cursor-skips",
    file: "Store.ts",
    find: "String(start + take) : null",
    replace: "String(start + take + 1) : null",
    suite: memory,
    why: "paging skips a row",
  },
  {
    id: "memory/page-overlaps",
    file: "Store.ts",
    find: "rows.slice(start, start + take)",
    replace: "rows.slice(start, start + take + 1)",
    suite: memory,
    why: "pages repeat a row",
  },
  {
    id: "memory/lag-unfiltered",
    file: "Store.ts",
    find: "rowsOf(spec, { where: request.where })",
    replace: "rowsOf(spec, {})",
    suite: memory,
    why: "lag summarizes every row",
  },
  {
    id: "memory/lag-quantile",
    file: "Store.ts",
    find: "Math.ceil(q * lags.length) - 1",
    replace: "Math.floor(q * lags.length)",
    suite: memory,
    why: "quantiles are not nearest-rank",
  },
  {
    id: "memory/promote-ignored",
    file: "Store.ts",
    find: "promoted.set(spec.name, generationName(spec))",
    replace: "promoted.get(spec.name)",
    suite: memory,
    why: "promotion changes nothing",
  },
  {
    id: "memory/reads-ignore-promotion",
    file: "Store.ts",
    find: "generation(promoted.get(spec.name) ?? generationName(spec))",
    replace: "generation(generationName(spec))",
    suite: memory,
    why: "readers never see the promoted generation",
  },
  {
    id: "memory/drift-ignored",
    file: "Store.ts",
    find: "held !== undefined && held !== spec.fingerprint",
    replace: "false",
    suite: memory,
    why: "a changed table is accepted under its old generation",
  },
  // ---------------------------------------------------------------- the SQL store
  {
    id: "sql/last-write-wins",
    file: "SqlStore.ts",
    find: "ON CONFLICT (${sql(IDENTITY)}) DO NOTHING",
    replace:
      "ON CONFLICT (${sql(IDENTITY)}) DO UPDATE SET ${sql(JSON_COLUMN)} = excluded.${sql(JSON_COLUMN)}",
    suite: sqlite,
    why: "a retry overwrites the first write",
  },
  {
    id: "sql/identity-by-event",
    file: "SqlStore.ts",
    find: "const identity = identityKey(identityOf(row));",
    replace: 'const identity = identityKey({ ...identityOf(row), key: "", route: undefined });',
    suite: sqlite,
    why: "an event routed to two keys keeps only its first row",
  },
  {
    id: "sql/no-carry",
    file: "SqlStore.ts",
    find: "Metadata.evaluate(spec.metadata, row, run, previous.get(identity))",
    replace: "Metadata.evaluate(spec.metadata, row, run, undefined)",
    suite: sqlite,
    why: "a rebuild forgets when rows first arrived",
  },
  {
    id: "sql/three-valued",
    file: "SqlStore.ts",
    find: "sql`COALESCE((${predicate}), ${FALSE})`",
    replace: "predicate",
    suite: sqlite,
    why: "NOT over a null comparison drops rows Filter.matches keeps",
  },
  {
    id: "sql/binary-order-any-operand",
    file: "SqlStore.ts",
    find: "isAscii(operand)",
    replace: "true",
    suite: sqlite,
    why: "a non-ASCII bound compares in UTF-8 byte order, not JavaScript's",
  },
  {
    id: "sql/keyset-inclusive",
    file: "SqlStore.ts",
    find: "sql`${sql(ORD)} > ${after}`",
    replace: "sql`${sql(ORD)} >= ${after}`",
    suite: sqlite,
    why: "a page repeats the previous page's last row",
  },
  {
    id: "sql/not-log-order",
    file: "SqlStore.ts",
    find: "sql.csv([...order, sql`${sql(ORD)}`])",
    replace: "sql.csv([...order, sql`${sql(IDENTITY)}`])",
    suite: sqlite,
    why: "rows come out of log order, and ties of a pushed ordering lose it",
  },
  {
    id: "sql/order-direction-ignored",
    file: "SqlStore.ts",
    find: 'sql.literal(direction === "desc" ? "DESC" : "ASC")',
    replace: 'sql.literal("ASC")',
    suite: sqlite,
    why: "an ordering pushed to SQL ignores `desc`",
  },
  {
    id: "sql/lag-unfiltered",
    file: "SqlStore.ts",
    find: "WHERE ${and([...pushed, sql`${lag} IS NOT NULL`])}",
    replace: "WHERE ${sql`${lag} IS NOT NULL`}",
    suite: sqlite,
    why: "the lag summary SQL computes covers every row, not the ones the filter selects",
  },
  {
    id: "sql/lag-rank-floor",
    file: "SqlStore.ts",
    find: "`(n * ${q} + 99) / 100`",
    replace: "`(n * ${q}) / 100`",
    suite: sqlite,
    why: "a lag quantile in SQL takes the rank below the nearest rank",
  },
  {
    id: "sql/residual-dropped",
    file: "SqlStore.ts",
    find: "rows.filter((row) => DomainFilter.matches(residual, row))",
    replace: "rows",
    suite: sqlite,
    why: "the part of a filter SQL cannot evaluate is ignored",
  },
  {
    id: "sql/scan-residual-dropped",
    file: "SqlStore.ts",
    find: "map(({ row }) => row).filter((row) => DomainFilter.matches(residual, row))",
    replace: "map(({ row }) => row)",
    suite: sqlite,
    why: "a scan ignores the part of a filter SQL cannot evaluate",
  },
  {
    id: "sql/promote-ignored",
    file: "SqlStore.ts",
    find: "ON CONFLICT (name) DO UPDATE SET generation = excluded.generation",
    replace: "ON CONFLICT (name) DO NOTHING",
    suite: sqlite,
    why: "a second promotion changes nothing",
  },
  {
    id: "sql/drift-ignored",
    file: "SqlStore.ts",
    find: "held !== undefined && held.fingerprint !== spec.fingerprint",
    replace: "false",
    suite: sqlite,
    why: "a changed table is accepted under its old generation",
  },
  {
    id: "sql/view-not-repointed",
    file: "SqlStore.ts",
    find: "yield* pointView(spec.name, own, storedColumnsOf(spec));",
    replace: "",
    suite: "Domain/ExportEngine.test.ts",
    why: "engines keep reading the old generation after a promotion",
  },
  // ---------------------------------------------------------------- the SQL store's Iceberg dialect
  {
    id: "iceberg/append-not-merge",
    file: "SqlStore.ts",
    find: "ON (s.${sql(IDENTITY)} = t.${sql(IDENTITY)}) WHEN NOT MATCHED THEN INSERT",
    replace: "ON (FALSE) WHEN NOT MATCHED THEN INSERT",
    suite: iceberg,
    why: "a retry appends its rows again instead of keeping the first write",
  },
  {
    id: "iceberg/oldest-promotion-wins",
    file: "SqlStore.ts",
    find: "WHERE name = ${spec.name} ORDER BY ord DESC LIMIT 1",
    replace: "WHERE name = ${spec.name} ORDER BY ord ASC LIMIT 1",
    suite: iceberg,
    why: "a second promotion is ignored: the first one recorded keeps winning",
  },
  {
    id: "iceberg/stable-name-ignores-promotion",
    file: "SqlStore.ts",
    find: "qualify(Option.getOrElse(promoted, () => generationName(spec)))",
    replace: "qualify(generationName(spec))",
    suite: iceberg,
    why: "engines read each spec's own generation, not the promoted one",
  },
  {
    id: "iceberg/run-duplicates-kept",
    file: "SqlStore.ts",
    find: "prepared.findIndex((other) => other.identity === entry.identity) === index",
    replace: "true",
    suite: iceberg,
    why: "a run holding one identity twice stores it twice",
  },
  {
    id: "iceberg/view-left-behind",
    file: "Iceberg.ts",
    find: "promote: (spec) => Effect.tap(target.promote(spec), () => follow(spec, true)),",
    replace: "promote: (spec) => Effect.tap(target.promote(spec), () => follow(spec, false)),",
    suite: "DomainExport/Consumers.test.ts",
    tags: ["export-lakes"],
    why: "a promotion moves engines but not the catalog's view: Spark keeps reading the old generation",
  },
  // ---------------------------------------------------------------- the MySQL dialect
  {
    id: "mysql/pad-space",
    file: "SqlStore.ts",
    find: 'const mysqlText = "TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin";',
    replace: 'const mysqlText = "TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin";',
    suite: "DomainExport/StoreMysql.test.ts",
    why: "text compares with trailing spaces ignored: 'a' equals 'a '",
  },
  {
    id: "mysql/case-insensitive",
    file: "SqlStore.ts",
    find: 'const mysqlText = "TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin";',
    replace: 'const mysqlText = "TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci";',
    suite: "DomainExport/StoreMysql.test.ts",
    why: "text compares as MySQL's default does: 'a' equals 'A' and 'á'",
  },
  {
    id: "mysql/retry-overwrites",
    file: "SqlStore.ts",
    find: "ON DUPLICATE KEY UPDATE ${sql(IDENTITY)} = ${sql(IDENTITY)}",
    replace: "ON DUPLICATE KEY UPDATE ${sql(JSON_COLUMN)} = VALUES(${sql(JSON_COLUMN)})",
    suite: "DomainExport/StoreMysql.test.ts",
    why: "a retried write replaces the row it first wrote",
  },
  // ---------------------------------------------------------------- the engines
  {
    id: "trino/quote-unescaped",
    file: "Trino.ts",
    find: "const quoted = (text: string) => `'${text.replaceAll(\"'\", \"''\")}'`;",
    replace: "const quoted = (text: string) => `'${text}'`;",
    suite: "DomainExport/EngineTrinoPostgres.test.ts",
    why: "a string parameter holding a quote ends its literal early",
  },
  {
    id: "trino/first-page-only",
    file: "Trino.ts",
    find: "Option.map(Option.fromNullishOr(results.nextUri), (next) =>",
    replace: "Option.map(Option.none<string>(), (next) =>",
    suite: "DomainExport/EngineTrinoPostgres.test.ts",
    why: "a query's answer is read from its first page only",
  },
  {
    id: "duckdb/plan-kept",
    file: "DuckDb.ts",
    find: `    call(pooled, "DuckDBPrepare", () => pooled.connection.prepare(text)),
    (prepared) => Effect.sync(() => prepared.destroySync()),`,
    replace: `    call(pooled, "DuckDBPrepare", () => {
      const plans: Map<string, Promise<any>> = ((pooled.connection as any).plans ??= new Map());
      if (!plans.has(text)) plans.set(text, pooled.connection.prepare(text));
      return plans.get(text)!;
    }),
    () => Effect.void,`,
    suite: "Domain/ExportEngine.test.ts",
    why: "a connection keeps each statement's plan and runs it again after the table changed",
  },
  {
    id: "duckdb/instant-as-text",
    file: "DuckDb.ts",
    find: "Match.when(Predicate.isDate, (date) => jsToDuckDBValue(date, TIMESTAMPTZ)),",
    replace: "Match.when(Predicate.isDate, (date) => date.toString()),",
    suite: "Domain/ExportEngineConformance.test.ts",
    why: "an instant parameter binds as its local text, not a timestamp",
  },
  {
    id: "engine/name-unresolved",
    file: "Engine.ts",
    find: "? Effect.succeed(resolved)\n          : resolved;",
    replace: "? Effect.succeed(resolved)\n          : Effect.succeed(table);",
    suite: "DomainExport/StoreIceberg.test.ts",
    why: "an engine reads a table by its declared name, not the generation its store promoted",
  },
  {
    id: "sql/stream-where-collect",
    file: "Sql.ts",
    find: 'options.stream === "collect"',
    replace: "false",
    suite: "Domain/ExportEngineConformance.test.ts",
    why: "an engine asked to collect streams from a client that cannot",
  },
  {
    id: "engine/clickhouse-instant-as-date",
    file: "Engine.ts",
    find: 'engine.dialect === "mysql" || engine.dialect === "clickhouse"',
    replace: 'engine.dialect === "mysql"',
    suite: "DomainExport/StoreClickhouse.test.ts",
    why: "a sub-second instant binds to ClickHouse as whole seconds and fails to parse",
  },
  // ---------------------------------------------------------------- ClickHouse's own code
  {
    id: "clickhouse/oldest-promotion-wins",
    file: "SqlStore.ts",
    find: "WHERE name = ${spec.name} ORDER BY ord DESC LIMIT 1",
    replace: "WHERE name = ${spec.name} ORDER BY ord ASC LIMIT 1",
    suite: "DomainExport/StoreClickhouse.test.ts",
    why: "ClickHouse appends promotions: a second one is ignored when the first recorded wins",
  },
  {
    id: "clickhouse/instant-in-seconds",
    file: "SqlStore.ts",
    find: "return `Nullable(DateTime64(3, 'UTC')) MATERIALIZED parseDateTime64BestEffortOrNull(${text}, 3, 'UTC')`;",
    replace:
      "return `Nullable(DateTime('UTC')) MATERIALIZED parseDateTimeBestEffortOrNull(${text}, 'UTC')`;",
    suite: "DomainExport/StoreClickhouse.test.ts",
    why: "an instant column keeps whole seconds: comparisons near a sub-second boundary go wrong",
  },
  // ---------------------------------------------------------------- the Athena engine
  {
    id: "athena/parameters-unquoted",
    file: "Athena.ts",
    find: "ExecutionParameters: Arr.map(parameters, literal)",
    replace: "ExecutionParameters: Arr.map(parameters, String)",
    suite: "DomainExport/EngineTrinoPostgres.test.ts",
    why: "execution parameters pass as bare text, not SQL literals: text and instants are not quoted",
  },
  {
    id: "athena/timestamp-as-text",
    file: "Athena.ts",
    find: "() => timestampOf(cell),",
    replace: "() => cell,",
    suite: "DomainExport/EngineTrinoPostgres.test.ts",
    why: "a timestamp cell is returned as Athena's text, not an ISO instant",
  },
  {
    id: "engine/clickhouse-zone-less",
    file: "Sql.ts",
    find: 'date_time_output_format: "iso",',
    replace: 'date_time_output_format: "simple",',
    suite: "DomainExport/StoreClickhouse.test.ts",
    why: "ClickHouse returns instants as text without a zone, which a reader takes as local time",
  },
  {
    id: "engine/mysql-time-zone-unchecked",
    file: "Sql.ts",
    find: 'if (epoch !== "1970-01-01T00:00:00.000Z") {',
    replace: "if (false) {",
    suite: "DomainExport/StoreMysql.test.ts",
    why: "an engine builds on a MySQL client that shifts every instant by its zone",
  },
  {
    id: "iceberg/view-without-catalog",
    file: "Iceberg.ts",
    find: '...(viewCatalog === undefined ? {} : { "default-catalog": viewCatalog }),',
    replace: "",
    suite: "DomainExport/EngineTrinoIceberg.test.ts",
    why: "the view names no catalog: Trino refuses to read it",
  },
];
