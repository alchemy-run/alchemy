import type * as runtime from "@cloudflare/workers-types";
import { describe, expect, it } from "alchemy-test";
import { wrapD1ForMigrations } from "@/d1Migrations.ts";

const result = <T>(results: T[]): runtime.D1Result<T> =>
  ({ results, success: true, meta: {} }) as runtime.D1Result<T>;

const statement = <T>(rows: T[]): runtime.D1PreparedStatement =>
  ({
    bind: () => statement(rows),
    all: async () => result(rows),
    first: async () => rows[0] ?? null,
    run: async () => result(rows),
    raw: async () => rows.map((row) => Object.values(row as object)),
  }) as runtime.D1PreparedStatement;

describe("wrapD1ForMigrations", () => {
  it("recovers indexes from sqlite_master instead of pragma_index_list", async () => {
    const seen: string[] = [];
    const inner = {
      prepare: (sql: string) => {
        seen.push(sql);
        if (sql.includes("type = 'index'")) {
          return statement([
            {
              name: "account_issuer_idx",
              tbl_name: "account",
              sql: 'CREATE INDEX "account_issuer_idx" ON "account" ("issuer")',
            },
            {
              name: "sqlite_autoindex_user_1",
              tbl_name: "user",
              sql: null,
            },
          ]);
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    } as runtime.D1Database;

    const wrapped = wrapD1ForMigrations(inner);
    const rows = await wrapped
      .prepare(
        `SELECT * FROM sqlite_master AS tables
         INNER JOIN pragma_index_list(tables.name) AS index_list
         INNER JOIN pragma_index_info(index_list.name) AS index_info`,
      )
      .all();

    expect(seen).toEqual([
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index'",
    ]);
    expect(rows.results).toEqual([
      {
        tableName: "account",
        indexName: "account_issuer_idx",
        columnName: "issuer",
        isUnique: 0,
        isPartial: 0,
        columnPosition: 0,
      },
      {
        tableName: "user",
        indexName: "sqlite_autoindex_user_1",
        columnName: null,
        isUnique: 1,
        isPartial: 0,
        columnPosition: 0,
      },
    ]);
  });

  it("recovers columns from sqlite_master instead of pragma_table_info", async () => {
    const seen: { sql: string; binds: unknown[] }[] = [];
    const inner = {
      prepare: (sql: string) => {
        const binds: unknown[] = [];
        const stmt = {
          bind: (...values: unknown[]) => {
            binds.push(...values);
            return stmt;
          },
          all: async () => {
            seen.push({ sql, binds: [...binds] });
            return result([
              {
                sql: 'CREATE TABLE "account" ("id" TEXT NOT NULL PRIMARY KEY, "issuer" TEXT, "userId" TEXT NOT NULL)',
              },
            ]);
          },
        };
        return stmt;
      },
    } as unknown as runtime.D1Database;

    const wrapped = wrapD1ForMigrations(inner);
    const rows = await wrapped
      .prepare("SELECT * FROM pragma_table_info(?)")
      .bind("account")
      .all();

    expect(seen).toEqual([
      {
        sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        binds: ["account"],
      },
    ]);
    expect(rows.results).toEqual([
      {
        cid: 0,
        name: "id",
        type: "TEXT",
        notnull: 1,
        dflt_value: null,
        pk: 1,
      },
      {
        cid: 1,
        name: "issuer",
        type: "TEXT",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
      {
        cid: 2,
        name: "userId",
        type: "TEXT",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
    ]);
  });
});
