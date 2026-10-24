import { splitSqliteStatements, splitSqlStatements } from "@alchemy.run/sql/SqlFile";
import { describe, expect, test } from "@alchemy.run/test";

describe("SqlFile", { tags: ["unit", "local"] }, () => {
  describe("splitSqlStatements", () => {
    test("splits statements separated by breakpoints on their own line", () => {
      const sql = [
        "CREATE TABLE `users` (\n\t`id` int NOT NULL\n);",
        "--> statement-breakpoint",
        "CREATE TABLE `sessions` (\n\t`id` int NOT NULL\n);",
      ].join("\n");
      expect(splitSqlStatements(sql)).toEqual([
        "CREATE TABLE `users` (\n\t`id` int NOT NULL\n);",
        "CREATE TABLE `sessions` (\n\t`id` int NOT NULL\n);",
      ]);
    });

    // drizzle-kit puts the marker on the same line after single-line
    // statements (`...;--> statement-breakpoint`). A newline-anchored split
    // misses those, and the leftover `-->` makes Vitess bail with
    // "syntax error at position 2".
    test("splits breakpoints appended on the same line as the statement", () => {
      const sql = [
        "CREATE TABLE `users` (\n\t`id` int NOT NULL\n);",
        "--> statement-breakpoint",
        "CREATE INDEX `users_email` ON `users` (`email`);--> statement-breakpoint",
        "CREATE INDEX `users_name` ON `users` (`name`);",
      ].join("\n");
      expect(splitSqlStatements(sql)).toEqual([
        "CREATE TABLE `users` (\n\t`id` int NOT NULL\n);",
        "CREATE INDEX `users_email` ON `users` (`email`);",
        "CREATE INDEX `users_name` ON `users` (`name`);",
      ]);
    });

    test("splits CRLF-separated breakpoints", () => {
      const sql =
        "CREATE TABLE `users` (`id` int);\r\n--> statement-breakpoint\r\nCREATE TABLE `sessions` (`id` int);";
      expect(splitSqlStatements(sql)).toEqual([
        "CREATE TABLE `users` (`id` int);",
        "CREATE TABLE `sessions` (`id` int);",
      ]);
    });

    test("drops empty segments and keeps sql without markers intact", () => {
      expect(splitSqlStatements("--> statement-breakpoint\n")).toEqual([]);
      expect(splitSqlStatements("SELECT 1;")).toEqual(["SELECT 1;"]);
    });
  });

  describe("splitSqliteStatements", () => {
    test("splits on semicolons and drops the terminators", () => {
      expect(
        splitSqliteStatements("CREATE TABLE t (id INTEGER);\nINSERT INTO t VALUES (1);\n"),
      ).toEqual(["CREATE TABLE t (id INTEGER)", "INSERT INTO t VALUES (1)"]);
    });

    test("keeps a final statement without a semicolon", () => {
      expect(splitSqliteStatements("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
    });

    test("ignores semicolons inside strings, quoted identifiers, and comments", () => {
      const sql = [
        "INSERT INTO t VALUES ('a;b', 'it''s; fine');",
        'CREATE TABLE "x;y" (`a;` TEXT, [b;] TEXT);',
        "-- a comment; not a statement",
        "/* block; comment */ SELECT 1;",
      ].join("\n");
      expect(splitSqliteStatements(sql)).toEqual([
        "INSERT INTO t VALUES ('a;b', 'it''s; fine')",
        'CREATE TABLE "x;y" (`a;` TEXT, [b;] TEXT)',
        "-- a comment; not a statement\n/* block; comment */ SELECT 1",
      ]);
    });

    test("keeps a trigger body as one statement", () => {
      const trigger = [
        "CREATE TEMP TRIGGER log_insert AFTER INSERT ON t",
        "BEGIN",
        "  INSERT INTO log VALUES (new.id);",
        "  UPDATE counts SET n = n + 1;",
        "END",
      ].join("\n");
      expect(splitSqliteStatements(`${trigger};\nSELECT 1;`)).toEqual([trigger, "SELECT 1"]);
    });

    test("drops comment-only and empty segments", () => {
      expect(splitSqliteStatements(";;\n-- only a comment\n")).toEqual([]);
      expect(splitSqliteStatements("")).toEqual([]);
    });
  });
});
