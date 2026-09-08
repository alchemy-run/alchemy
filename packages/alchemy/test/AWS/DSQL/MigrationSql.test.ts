import { prepareDsqlStatements } from "@/AWS/DSQL/MigrationSql.ts";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

test.effect(
  "DSQL splits scripts without splitting SQL literals or comments",
  () =>
    Effect.gen(function* () {
      const statements = yield* prepareDsqlStatements(
        `
    -- CREATE SEQUENCE nope;
    CREATE TABLE "serial" (id uuid PRIMARY KEY, value text DEFAULT 'a;''b');
    /* outer ; /* inner ; */ */ INSERT INTO "serial" VALUES (gen_random_uuid(), $$a;b$$);
    INSERT INTO "serial" VALUES (gen_random_uuid(), E'a\\';b');
  `,
        "0001.sql",
      );
      expect(statements).toHaveLength(3);
      expect(statements[0]).toContain("'a;''b'");
      expect(statements[1]).toContain("$$a;b$$");
    }),
);

test.effect(
  "DSQL adapts Drizzle indexes and accepts current foreign key and sequence syntax",
  () =>
    Effect.gen(function* () {
      const statements = yield* prepareDsqlStatements(
        `
    CREATE TABLE users (id uuid PRIMARY KEY);
    --> statement-breakpoint
    CREATE TABLE posts (id uuid PRIMARY KEY, user_id uuid REFERENCES users(id));
    CREATE INDEX "posts_user" ON "posts" USING btree ("user_id");
    CREATE UNIQUE INDEX ASYNC "users_id" ON users (id);
    CREATE SEQUENCE ids CACHE 65536;
  `,
        "schema",
      );
      expect(statements).toHaveLength(5);
      expect(statements[2]).toBe(
        'CREATE INDEX ASYNC "posts_user" ON "posts"  ("user_id")',
      );
      expect(statements[3]).toBe(
        'CREATE UNIQUE INDEX ASYNC "users_id" ON users (id)',
      );
    }),
);

for (const sql of [
  "BEGIN; CREATE TABLE users(id uuid); COMMIT;",
  "CREATE TABLE users(id serial PRIMARY KEY);",
  "CREATE SEQUENCE ids;",
  "CREATE INDEX CONCURRENTLY users_id ON users(id);",
  "CREATE TABLE users(id bigint GENERATED ALWAYS AS IDENTITY);",
  "CREATE TABLE users(id text DEFAULT 'unterminated);",
]) {
  test.effect(`DSQL preflight rejects ${sql}`, () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        prepareDsqlStatements(sql, "0004_users.sql"),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure.message).toContain("0004_users.sql");
    }),
  );
}

for (const sql of [
  "CREATE SEQUENCE ids CACHE 65535;",
  "CREATE TABLE users(a bigint GENERATED ALWAYS AS IDENTITY (CACHE 65536), b bigint GENERATED ALWAYS AS IDENTITY);",
  "SET search_path TO another_schema;",
]) {
  test.effect(
    `DSQL validates all sequence definitions and session settings: ${sql}`,
    () =>
      Effect.gen(function* () {
        expect(
          Result.isFailure(
            yield* Effect.result(prepareDsqlStatements(sql, "0001.sql")),
          ),
        ).toBe(true);
      }),
  );
}

test.effect(
  "DSQL retains literal-only statements for database validation",
  () =>
    Effect.gen(function* () {
      expect(
        yield* prepareDsqlStatements(
          "'not a command'; $$nor is this$$; -- comment",
          "0001.sql",
        ),
      ).toEqual(["'not a command'", "$$nor is this$$"]);
    }),
);
