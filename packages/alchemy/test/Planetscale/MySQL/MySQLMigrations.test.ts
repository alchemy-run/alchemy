import { splitMySQLStatements } from "@/Planetscale/MySQL/MySQLMigrations";
import { describe, expect, test } from "alchemy-test";

describe("MySQLMigrations", () => {
  describe("splitMySQLStatements", () => {
    test("splits statements separated by breakpoints on their own line", () => {
      const sql = [
        "CREATE TABLE `users` (\n\t`id` int NOT NULL\n);",
        "--> statement-breakpoint",
        "CREATE TABLE `sessions` (\n\t`id` int NOT NULL\n);",
      ].join("\n");
      expect(splitMySQLStatements(sql)).toEqual([
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
      expect(splitMySQLStatements(sql)).toEqual([
        "CREATE TABLE `users` (\n\t`id` int NOT NULL\n);",
        "CREATE INDEX `users_email` ON `users` (`email`);",
        "CREATE INDEX `users_name` ON `users` (`name`);",
      ]);
    });

    test("splits CRLF-separated breakpoints", () => {
      const sql =
        "CREATE TABLE `users` (`id` int);\r\n--> statement-breakpoint\r\nCREATE TABLE `sessions` (`id` int);";
      expect(splitMySQLStatements(sql)).toEqual([
        "CREATE TABLE `users` (`id` int);",
        "CREATE TABLE `sessions` (`id` int);",
      ]);
    });

    test("drops empty segments and keeps sql without markers intact", () => {
      expect(splitMySQLStatements("--> statement-breakpoint\n")).toEqual([]);
      expect(splitMySQLStatements("SELECT 1;")).toEqual(["SELECT 1;"]);
    });
  });
});
