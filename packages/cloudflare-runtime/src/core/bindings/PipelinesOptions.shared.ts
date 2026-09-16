/** Local Pipelines supports row projections and scalar WHERE comparisons. */
export interface PipelineQuery {
  sink: string;
  stream: string;
  columns: "*" | { field: string; alias: string }[];
  where?: {
    field: string;
    operator: string;
    value: string | number | boolean | null;
  };
}

/** Reject SQL outside the implemented subset before accepting any events. */
export const parsePipelineSql = (sql: string): PipelineQuery[] => {
  const statements = sql
    .trim()
    .replace(/;\s*$/, "")
    .split(/;(?=(?:[^']*'[^']*')*[^']*$)/);
  if (!statements.length)
    throw new Error(
      "Local Pipelines requires an INSERT INTO ... SELECT statement",
    );
  return statements.map((statement) => {
    const match =
      /^\s*INSERT\s+INTO\s+([A-Za-z_]\w*)\s+SELECT\s+([\s\S]+?)\s+FROM\s+([A-Za-z_]\w*)(?:\s+WHERE\s+([\s\S]+?))?\s*$/i.exec(
        statement,
      );
    if (!match)
      throw new Error(
        "Local Pipelines supports INSERT INTO sink SELECT columns FROM stream [WHERE column operator literal]; CTEs, joins and expressions require remote Pipelines",
      );
    const [, sink, select, stream, condition] = match;
    const columns =
      select!.trim() === "*"
        ? ("*" as const)
        : select!.split(",").map((column) => {
            const field =
              /^\s*([A-Za-z_]\w*)(?:\s+AS\s+([A-Za-z_]\w*))?\s*$/i.exec(column);
            if (!field)
              throw new Error(
                `Unsupported local Pipelines projection: ${column.trim()}`,
              );
            return { field: field[1]!, alias: field[2] ?? field[1]! };
          });
    if (
      columns !== "*" &&
      new Set(columns.map((c) => c.alias)).size !== columns.length
    )
      throw new Error(
        "Local Pipelines projection contains duplicate output columns",
      );
    let where: PipelineQuery["where"];
    if (condition) {
      const predicate =
        /^\s*([A-Za-z_]\w*)\s*(=|!=|<>|<=|>=|<|>|IS\s+NOT|IS)\s*('(?:[^']|'')*'|-?\d+(?:\.\d+)?|true|false|null)\s*$/i.exec(
          condition,
        );
      if (!predicate)
        throw new Error(
          `Unsupported local Pipelines WHERE expression: ${condition}`,
        );
      const literal = predicate[3]!;
      const value = literal.startsWith("'")
        ? literal.slice(1, -1).replaceAll("''", "'")
        : /^(true|false|null)$/i.test(literal)
          ? JSON.parse(literal.toLowerCase())
          : Number(literal);
      const operator = predicate[2]!.toUpperCase().replace(/\s+/g, " ");
      if (operator.startsWith("IS") && value !== null)
        throw new Error("Local Pipelines IS predicates only support NULL");
      where = { field: predicate[1]!, operator, value };
    }
    return { sink: sink!, stream: stream!, columns, where };
  });
};

export interface LocalPipelineField {
  name: string;
  type: string;
  required?: boolean;
  sqlName?: string;
}

export interface LocalPipelineRoute {
  query: PipelineQuery;
  bucket: string;
  path?: string;
  compression?: "uncompressed" | "gzip";
  filePrefix?: string;
  fileSuffix?: string;
  timePattern?: string;
}

export interface LocalPipelinesProps {
  binding: string;
  stream: string;
  enabled: boolean;
  fields?: LocalPipelineField[];
  routes: LocalPipelineRoute[];
}

export const transformPipelineRecord = (
  record: Record<string, unknown>,
  query: PipelineQuery,
): Record<string, unknown> | undefined => {
  if (query.where) {
    const { field, operator, value } = query.where;
    const actual = record[field] ?? null;
    let matches = false;
    if (operator === "IS") matches = actual === null;
    else if (operator === "IS NOT") matches = actual !== null;
    else if (actual !== null && value !== null) {
      if (operator === "=") matches = actual === value;
      else if (operator === "!=" || operator === "<>")
        matches = actual !== value;
      else if (
        (typeof actual === "number" && typeof value === "number") ||
        (typeof actual === "string" && typeof value === "string")
      ) {
        if (operator === ">") matches = actual > value;
        if (operator === ">=") matches = actual >= value;
        if (operator === "<") matches = actual < value;
        if (operator === "<=") matches = actual <= value;
      }
    }
    if (!matches) return undefined;
  }
  return query.columns === "*"
    ? record
    : Object.fromEntries(
        query.columns.map(({ field, alias }) => [alias, record[field] ?? null]),
      );
};
