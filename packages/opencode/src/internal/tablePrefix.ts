/**
 * Keeps OpenCode's tables apart from everything else in a Durable Object's
 * SQLite. OpenCode names its tables plainly (`event`, `job`, `kv`,
 * `project`), which a table of yours could share, so its SQL is rewritten
 * to put every table and index it names under a prefix.
 *
 * Ported from `prefixTables` in Cloudflare's Agents SDK (cloudflare/agents,
 * MIT), which hosts OpenCode the same way.
 *
 * @internal
 */

/** The parts of a Durable Object's storage the rewrite touches. */
interface SqlStorage {
  exec(query: string, ...bindings: ReadonlyArray<unknown>): { toArray(): Array<unknown> };
}

type Token =
  | { readonly kind: "space" | "string" | "word" | "punct"; readonly text: string }
  | {
      readonly kind: "quoted";
      readonly text: string;
      readonly name: string;
      readonly open: string;
      readonly close: string;
    };

/** Words after which an identifier names a table or index in DDL. */
const DDL_KEYWORDS = new Set(["TABLE", "INDEX", "REFERENCES"]);
/** Words after which an identifier names a table in DML. */
const DML_KEYWORDS = new Set(["FROM", "JOIN", "INTO", "UPDATE"]);
/** Words that may follow `sqlite_master` without being its alias. */
const CLAUSE_KEYWORDS = new Set([
  "WHERE",
  "ORDER",
  "GROUP",
  "LIMIT",
  "JOIN",
  "LEFT",
  "INNER",
  "CROSS",
  "ON",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "HAVING",
  "WINDOW",
]);
const MASTER_TABLES = new Set(["sqlite_master", "sqlite_schema"]);
/** PRAGMAs whose argument is a table or index name. */
const SCHEMA_PRAGMAS = new Set([
  "table_info",
  "table_xinfo",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "foreign_key_check",
  "integrity_check",
  "quick_check",
]);
/** Bare words that follow a table keyword without naming a table: `TABLE IF NOT EXISTS`, `FROM (SELECT …)`. */
const NOT_NAMES = new Set(["IF", "NOT", "EXISTS", "SELECT", "VALUES", "OR"]);

const upper = (token: Token | undefined) =>
  token?.kind === "word" ? token.text.toUpperCase() : "";

/** The index just past the quote that closes the one at `start`. */
const closing = (sql: string, start: number, close: string) => {
  let j = start + 1;
  while (j < sql.length) {
    if (sql[j] === close) {
      if (close !== "]" && sql[j + 1] === close) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return sql.length;
};

/** SQL as identifiers, literals and everything else. Comments are kept as whitespace. */
const tokenize = (sql: string): Array<Token> => {
  const tokens: Array<Token> = [];
  let i = 0;
  while (i < sql.length) {
    const char = sql[i]!;
    let j = i + 1;
    if (/\s/.test(char)) {
      while (j < sql.length && /\s/.test(sql[j]!)) j++;
      tokens.push({ kind: "space", text: sql.slice(i, j) });
    } else if (char === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      j = end === -1 ? sql.length : end;
      tokens.push({ kind: "space", text: sql.slice(i, j) });
    } else if (char === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      j = end === -1 ? sql.length : end + 2;
      tokens.push({ kind: "space", text: sql.slice(i, j) });
    } else if (char === "'") {
      j = closing(sql, i, "'");
      tokens.push({ kind: "string", text: sql.slice(i, j) });
    } else if (char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      j = closing(sql, i, close);
      const text = sql.slice(i, j);
      tokens.push({
        kind: "quoted",
        text,
        name: text.slice(1, -1).replaceAll(close === "]" ? "]]" : close + close, close),
        open: char,
        close,
      });
    } else if (/[A-Za-z_]/.test(char)) {
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
      tokens.push({ kind: "word", text: sql.slice(i, j) });
    } else {
      tokens.push({ kind: "punct", text: char });
    }
    i = j;
  }
  return tokens;
};

type Significant = ReadonlyArray<{ readonly token: Token; readonly index: number }>;

/** Whether the identifier at `i` names a table in DDL, DML, or neither. */
const tablePosition = (significant: Significant, i: number, isCreateIndex: boolean) => {
  let j = i - 1;
  if (upper(significant[j]?.token) === "EXISTS") {
    j -= 1;
    if (upper(significant[j]?.token) === "NOT") j -= 1;
    if (upper(significant[j]?.token) !== "IF") return undefined;
    j -= 1;
  }
  const keyword = upper(significant[j]?.token);
  if (DDL_KEYWORDS.has(keyword)) return "ddl";
  if (keyword === "TO" && upper(significant[j - 1]?.token) === "RENAME") return "ddl";
  if (keyword === "ON" && isCreateIndex) return "ddl";
  if (DML_KEYWORDS.has(keyword)) return "dml";
  return undefined;
};

/** `query` with every table and index it names under `prefix`; `names` are the ones known so far. */
const rewrite = (query: string, prefix: string, masterView: string, names: Set<string>): string => {
  const tokens = tokenize(query);
  const significant = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => token.kind !== "space");
  const out = tokens.map((token) => token.text);
  const prefixed = (token: Token) =>
    token.kind === "quoted"
      ? `${token.open}${prefix}${token.name}${token.close}`
      : `${prefix}${token.text}`;
  const firstWord = upper(significant[0]?.token);
  const isCreateIndex =
    firstWord === "CREATE" && significant.slice(1, 4).some(({ token }) => upper(token) === "INDEX");
  for (let i = 0; i < significant.length; i++) {
    const { token, index } = significant[i]!;
    if (token.kind !== "word" && token.kind !== "quoted") continue;
    if (token.kind === "word" && NOT_NAMES.has(token.text.toUpperCase())) continue;
    const lower = (token.kind === "quoted" ? token.name : token.text).toLowerCase();
    const previous = significant[i - 1]?.token;
    const next = significant[i + 1]?.token;
    if (previous?.text === ".") continue;
    const position = tablePosition(significant, i, isCreateIndex);
    if (position === "dml" && MASTER_TABLES.has(lower)) {
      // The schema table is read through a view that shows only the prefix's own.
      const aliased =
        upper(next) === "AS" ||
        (next !== undefined &&
          (next.kind === "word" || next.kind === "quoted") &&
          !CLAUSE_KEYWORDS.has(upper(next)));
      out[index] = aliased ? masterView : `${masterView} AS ${token.text}`;
      continue;
    }
    if (lower.startsWith("sqlite_")) continue;
    if (position === "ddl") {
      names.add(lower);
      out[index] = prefixed(token);
      continue;
    }
    if (position === "dml" && names.has(lower)) {
      out[index] = prefixed(token);
      continue;
    }
    if (next?.text === "." && significant[i + 2] !== undefined && names.has(lower)) {
      out[index] = prefixed(token);
      continue;
    }
    if (lower.startsWith("pragma_") && next?.text === "(") {
      const argument = significant[i + 2];
      if (argument?.token.kind === "string") {
        const inner = argument.token.text.slice(1, -1);
        if (names.has(inner.toLowerCase())) out[argument.index] = `'${prefix}${inner}'`;
      }
    }
    if (firstWord === "PRAGMA" && previous?.text === "(" && names.has(lower)) {
      out[index] = prefixed(token);
    }
  }
  const pragma = significant[2]?.token.text === "." ? significant[3]?.token : significant[1]?.token;
  const pragmaName =
    pragma?.kind === "word" ? pragma.text : pragma?.kind === "quoted" ? pragma.name : "";
  if (firstWord === "PRAGMA" && SCHEMA_PRAGMAS.has(pragmaName.toLowerCase())) {
    for (let i = 1; i < significant.length; i++) {
      const { token, index } = significant[i]!;
      if (token.kind !== "string" || significant[i - 1]?.token.text !== "(") continue;
      const inner = token.text.slice(1, -1);
      if (names.has(inner.toLowerCase())) out[index] = `'${prefix}${inner}'`;
    }
  }
  return out.join("");
};

/**
 * A view of a Durable Object's `storage` whose SQL is rewritten into
 * `prefix`'s namespace. Everything other than `sql.exec` is the storage
 * itself, so transactions and the rest of its API behave as before.
 */
export const prefixTables = <Storage extends object>(storage: Storage, prefix: string): Storage => {
  const raw = (storage as unknown as { readonly sql: SqlStorage }).sql;
  const length = prefix.length;
  const masterView = `(SELECT type, substr(name, ${length + 1}) AS name, substr(tbl_name, ${length + 1}) AS tbl_name, rootpage, sql FROM sqlite_master WHERE substr(name, 1, ${length}) = '${prefix}')`;
  let names: Set<string> | undefined;
  const cache = new Map<string, string>();
  const exec = (query: string, ...bindings: ReadonlyArray<unknown>) => {
    let rewritten = cache.get(query);
    if (rewritten === undefined) {
      names ??= new Set(
        (
          raw
            .exec("SELECT name FROM sqlite_master WHERE substr(name, 1, ?) = ?", length, prefix)
            .toArray() as Array<{ readonly name: string }>
        ).map((row) => row.name.slice(length).toLowerCase()),
      );
      const before = names.size;
      rewritten = rewrite(query, prefix, masterView, names);
      // A statement that named a new table changes how earlier ones are read.
      if (names.size === before) cache.set(query, rewritten);
      else cache.clear();
    }
    return raw.exec(rewritten, ...bindings);
  };
  const view = <Target extends object>(target: Target, replaced: string, value: unknown) =>
    new Proxy(target, {
      get(target, property) {
        if (property === replaced) return value;
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  return view(storage, "sql", view(raw, "exec", exec));
};
