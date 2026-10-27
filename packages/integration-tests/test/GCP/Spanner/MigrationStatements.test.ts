import { splitSpannerStatements } from "@alchemy.run/gcp/Spanner/Migrations";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";

const tags = { tags: ["unit", "local"] };

const split = (sql: string, dialect: "googlesql" | "postgres") =>
  Effect.sync(() => splitSpannerStatements(sql, dialect));

describe("splitSpannerStatements", () => {
  it.effect(
    "splits on semicolons and drops terminators and blank statements",
    () =>
      Effect.gen(function* () {
        expect(yield* split("SELECT 1;\n\n;SELECT 2;  ", "googlesql")).toEqual([
          "SELECT 1",
          "SELECT 2",
        ]);
        expect(yield* split("SELECT 1", "postgres")).toEqual(["SELECT 1"]);
      }),
    tags,
  );

  it.effect(
    "removes line and block comments, including `;` inside them",
    () =>
      Effect.gen(function* () {
        expect(
          yield* split(
            "-- header; still a comment\nCREATE TABLE A (Id INT64) /* x; y */ PRIMARY KEY (Id); # gsql; comment\nSELECT 1",
            "googlesql",
          ),
        ).toEqual(["CREATE TABLE A (Id INT64)   PRIMARY KEY (Id)", "SELECT 1"]);
      }),
    tags,
  );

  it.effect(
    "treats `#` as a comment only in GoogleSQL",
    () =>
      Effect.gen(function* () {
        // The `;` inside the comment doesn't split.
        expect(yield* split("SELECT 1 # c; d\n+ 1; SELECT 2", "googlesql")).toEqual([
          "SELECT 1 \n+ 1",
          "SELECT 2",
        ]);
        expect(yield* split("SELECT '{1}'::jsonb #> '{}'; SELECT 2", "postgres")).toEqual([
          "SELECT '{1}'::jsonb #> '{}'",
          "SELECT 2",
        ]);
      }),
    tags,
  );

  it.effect(
    "nests block comments only in PostgreSQL",
    () =>
      Effect.gen(function* () {
        expect(yield* split("/* a /* b; */ c; */ SELECT 1; SELECT 2", "postgres")).toEqual([
          "SELECT 1",
          "SELECT 2",
        ]);
        // GoogleSQL ends the comment at the first `*/`.
        expect(yield* split("/* a /* b */ SELECT 1; SELECT 2", "googlesql")).toEqual([
          "SELECT 1",
          "SELECT 2",
        ]);
      }),
    tags,
  );

  it.effect(
    "keeps `;` and comment markers inside GoogleSQL strings and identifiers",
    () =>
      Effect.gen(function* () {
        expect(
          yield* split(
            "INSERT INTO `t;x` (a) VALUES ('it\\'s; -- not a comment'); SELECT \"a;b\", '''tri;ple ''quoted'' ''', \"\"\"x;\"\"\"",
            "googlesql",
          ),
        ).toEqual([
          "INSERT INTO `t;x` (a) VALUES ('it\\'s; -- not a comment')",
          "SELECT \"a;b\", '''tri;ple ''quoted'' ''', \"\"\"x;\"\"\"",
        ]);
      }),
    tags,
  );

  it.effect(
    "keeps `;` inside PostgreSQL doubled-quote strings and dollar quotes",
    () =>
      Effect.gen(function* () {
        expect(
          yield* split(
            "INSERT INTO t VALUES ('it''s; me', \"we\"\"ird;\"); SELECT $$a;b$$, $tag$c;$$d$tag$",
            "postgres",
          ),
        ).toEqual([
          "INSERT INTO t VALUES ('it''s; me', \"we\"\"ird;\")",
          "SELECT $$a;b$$, $tag$c;$$d$tag$",
        ]);
      }),
    tags,
  );
});
