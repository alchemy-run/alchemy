import type * as runtime from "@cloudflare/workers-types";

/**
 * D1's HTTP query API rejects SQLite table-valued pragma functions
 * (`SELECT … FROM pragma_index_list(…)`, `pragma_table_info(?)`) with
 * `SQLITE_AUTH`. Better Auth 1.7's `getMigrations` and the Kysely D1
 * introspector both use those forms.
 *
 * Standalone `PRAGMA index_list` is documented for wrangler but is also
 * `SQLITE_AUTH` over the HTTP query API, so we never send PRAGMA: indexes
 * and columns are recovered from `sqlite_master` DDL instead.
 *
 * @see https://github.com/better-auth/better-auth/issues/10551
 */
export const wrapD1ForMigrations = (
  db: runtime.D1Database,
): runtime.D1Database => ({
  ...db,
  prepare: (query: string) => {
    if (/pragma_index_list|pragma_index_info/i.test(query)) {
      return collectableStatement(() => collectIndexRows(db));
    }
    if (/pragma_table_info/i.test(query)) {
      return {
        ...collectableStatement(() => collectTableInfoRows(db, "")),
        bind: (...values: unknown[]) =>
          collectableStatement(() =>
            collectTableInfoRows(db, String(values[0] ?? "")),
          ),
      } as runtime.D1PreparedStatement;
    }
    return db.prepare(query);
  },
  batch: async <T = unknown>(statements: runtime.D1PreparedStatement[]) => {
    const results: runtime.D1Result<T>[] = [];
    const passthrough: runtime.D1PreparedStatement[] = [];
    const passthroughAt: number[] = [];
    for (const [index, statement] of statements.entries()) {
      const collect = (statement as CollectableStatement).__collect;
      if (collect) {
        results[index] = emptyResult(await collect()) as runtime.D1Result<T>;
      } else {
        passthroughAt.push(index);
        passthrough.push(statement);
      }
    }
    if (passthrough.length > 0) {
      const nested = await db.batch<T>(passthrough);
      passthroughAt.forEach((index, offset) => {
        results[index] = nested[offset]!;
      });
    }
    return results;
  },
});

interface IndexRow {
  tableName: string;
  indexName: string;
  columnName: string | null;
  isUnique: number;
  isPartial: number;
  columnPosition: number;
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface MasterIndexRow {
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface CollectableStatement extends runtime.D1PreparedStatement {
  __collect?: () => Promise<unknown[]>;
}

const collectIndexRows = async (
  db: runtime.D1Database,
): Promise<IndexRow[]> => {
  const indexes = await db
    .prepare(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index'",
    )
    .all<MasterIndexRow>();
  const rows: IndexRow[] = [];
  for (const index of indexes.results ?? []) {
    const parsed = parseCreateIndex(index);
    if (parsed.columns.length === 0) {
      rows.push({
        tableName: parsed.tableName,
        indexName: parsed.indexName,
        columnName: null,
        isUnique: parsed.unique,
        isPartial: parsed.partial,
        columnPosition: 0,
      });
      continue;
    }
    parsed.columns.forEach((column, position) => {
      rows.push({
        tableName: parsed.tableName,
        indexName: parsed.indexName,
        columnName: column,
        isUnique: parsed.unique,
        isPartial: parsed.partial,
        columnPosition: position,
      });
    });
  }
  return rows;
};

const collectTableInfoRows = async (
  db: runtime.D1Database,
  tableName: string,
): Promise<TableInfoRow[]> => {
  if (tableName === "") return [];
  const result = await db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(tableName)
    .all<{ sql: string | null }>();
  const sql = result.results?.[0]?.sql;
  if (!sql) return [];
  return parseCreateTable(sql);
};

const parseCreateIndex = (index: MasterIndexRow) => {
  const sql = index.sql ?? "";
  const unique = sql
    ? /^\s*CREATE\s+UNIQUE\s+INDEX\b/i.test(sql)
    : index.name.startsWith("sqlite_autoindex_");
  const partial = /\bWHERE\b/i.test(sql) ? 1 : 0;
  const match = sql.match(
    /\bON\s+((?:["'`][^"'`]+["'`]|\w+))\s*\((.*)\)(?:\s+WHERE\b.*)?$/is,
  );
  const tableName = match ? unquoteIdent(match[1]!) : index.tbl_name;
  const columns = match ? splitTopLevel(match[2]!).map(unquoteIdent) : [];
  return {
    tableName,
    indexName: index.name,
    unique: unique ? 1 : 0,
    partial,
    columns,
  };
};

const parseCreateTable = (sql: string): TableInfoRow[] => {
  const open = sql.indexOf("(");
  const close = sql.lastIndexOf(")");
  if (open < 0 || close < 0 || close <= open) return [];
  const rows: TableInfoRow[] = [];
  let cid = 0;
  const tablePk = new Set<string>();
  for (const part of splitTopLevel(sql.slice(open + 1, close))) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const tableConstraint = trimmed.match(
      /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\((.*)\)/i,
    );
    if (tableConstraint) {
      for (const column of splitTopLevel(tableConstraint[1]!)) {
        tablePk.add(unquoteIdent(column));
      }
      continue;
    }
    if (
      /^(?:CONSTRAINT\s+\S+\s+)?(?:UNIQUE|CHECK|FOREIGN\s+KEY)\b/i.test(trimmed)
    ) {
      continue;
    }
    const nameMatch = trimmed.match(/^((?:["'`][^"'`]+["'`]|\w+))\s*/);
    if (!nameMatch) continue;
    const name = unquoteIdent(nameMatch[1]!);
    const rest = trimmed.slice(nameMatch[0].length);
    const typeMatch = rest.match(/^(\w+(?:\s*\([^)]*\))?)/);
    const type = typeMatch?.[1] ?? "";
    const columnPk = /\bPRIMARY\s+KEY\b/i.test(rest);
    rows.push({
      cid,
      name,
      type,
      notnull:
        columnPk || /\bNOT\s+NULL\b/i.test(rest) || tablePk.has(name) ? 1 : 0,
      dflt_value: parseDefault(rest),
      pk: columnPk || tablePk.has(name) ? 1 : 0,
    });
    cid++;
  }
  for (const row of rows) {
    if (tablePk.has(row.name)) {
      row.pk = 1;
      row.notnull = 1;
    }
  }
  return rows;
};

const parseDefault = (rest: string): string | null => {
  const match = rest.match(/\bDEFAULT\s+((?:'[^']*'|"[^"]*"|\S+))/i);
  return match?.[1] ?? null;
};

const splitTopLevel = (input: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | undefined;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
};

const unquoteIdent = (raw: string): string => {
  const trimmed = raw.trim();
  const quoted = trimmed.match(/^["'`](.*)["'`]$/s);
  if (quoted) return quoted[1]!.replaceAll('""', '"');
  return trimmed.split(/\s+/)[0] ?? trimmed;
};

const emptyResult = <T>(results: T[]): runtime.D1Result<T> =>
  ({
    results,
    success: true,
    meta: {},
  }) as runtime.D1Result<T>;

const collectableStatement = (
  load: () => Promise<unknown[]>,
): CollectableStatement => {
  const all = async () => emptyResult(await load());
  return {
    __collect: load,
    bind: () => collectableStatement(load),
    all,
    first: (async (column?: string) => {
      const rows = await load();
      const first = rows[0] as Record<string, unknown> | undefined;
      if (first == null) return null;
      return column !== undefined ? (first[column] ?? null) : first;
    }) as runtime.D1PreparedStatement["first"],
    run: all,
    raw: (async (options?: { columnNames?: boolean }) => {
      const rows = (await load()) as Record<string, unknown>[];
      const arrays = rows.map((row) => Object.values(row));
      if (options?.columnNames && rows[0]) {
        return [Object.keys(rows[0]), ...arrays];
      }
      return arrays;
    }) as runtime.D1PreparedStatement["raw"],
  } as CollectableStatement;
};
