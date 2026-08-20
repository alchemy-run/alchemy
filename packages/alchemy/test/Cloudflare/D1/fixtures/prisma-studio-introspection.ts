import type { DatabaseSchema } from "@/Cloudflare/D1/IntrospectDatabase.ts";

// Exact schema-discovery query and parameters emitted by
// @prisma/studio-core's SQLite adapter.
export const PRISMA_STUDIO_INTROSPECTION_SQL = `select "tl"."name", "ss"."sql", (select coalesce(json_group_array(json_object('default', "agg"."default", 'name', "agg"."name", 'pk', "agg"."pk", 'datatype', "agg"."datatype", 'fk_table', "agg"."fk_table", 'fk_column', "agg"."fk_column", 'computed', "agg"."computed", 'nullable', "agg"."nullable")), '[]') from (select "txi"."dflt_value" as "default", "txi"."name", "txi"."pk", "txi"."type" as "datatype", "fkl"."table" as "fk_table", "fkl"."to" as "fk_column", "txi"."hidden" in (?, ?) as "computed", "txi"."notnull" = ? as "nullable" from pragma_table_xinfo("tl"."name") as "txi" left join pragma_foreign_key_list("tl"."name") as "fkl" on "fkl"."from" = "txi"."name" where "txi"."hidden" != ?) as agg) as "columns" from pragma_table_list() as "tl" left join "sqlite_schema" as "ss" on "ss"."type" = "tl"."type" and "ss"."name" = "tl"."name" where "tl"."type" in (?, ?) and "tl"."schema" = ? and "tl"."name" not like ?`;

export const PRISMA_STUDIO_INTROSPECTION_PARAMS = [
  2,
  3,
  0,
  1,
  "table",
  "view",
  "main",
  "sqlite_%",
] as const;

export const PRISMA_STUDIO_INTROSPECTION_REQUEST = {
  procedure: "query",
  query: {
    sql: PRISMA_STUDIO_INTROSPECTION_SQL,
    parameters: PRISMA_STUDIO_INTROSPECTION_PARAMS,
    transformations: { columns: "json-parse" },
  },
} as const;

export interface PrismaStudioIntrospectionRow {
  name: string;
  sql: string | null;
  columns: Array<{
    default: string | null;
    name: string;
    pk: number;
    datatype: string;
    fk_table: string | null;
    fk_column: string | null;
    computed: number;
    nullable: number;
  }>;
}

export const isPrismaStudioIntrospectionRequest = (value: unknown): boolean => {
  const request = value as typeof PRISMA_STUDIO_INTROSPECTION_REQUEST;
  return (
    request?.procedure === "query" &&
    request.query?.sql === PRISMA_STUDIO_INTROSPECTION_SQL &&
    JSON.stringify(request.query.parameters) ===
      JSON.stringify(PRISMA_STUDIO_INTROSPECTION_PARAMS)
  );
};

export const toPrismaStudioIntrospection = (
  schema: DatabaseSchema,
): PrismaStudioIntrospectionRow[] =>
  schema.tables.map((table) => ({
    name: table.name,
    sql: table.sql,
    columns: table.columns.map((column) => ({
      default: column.defaultValue,
      name: column.name,
      pk: column.primaryKey ? 1 : 0,
      datatype: column.datatype,
      fk_table: column.foreignKeys[0]?.table ?? null,
      fk_column: column.foreignKeys[0]?.column ?? null,
      computed: column.computed ? 1 : 0,
      nullable: column.nullable ? 1 : 0,
    })),
  }));
