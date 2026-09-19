import {
  makeDsqlMigrationExecutor,
  withDsqlMigrationLock,
} from "@/AWS/DSQL/Migrations.ts";
import {
  applyAlchemyFormat,
  MigrationError,
  type MigrationRecord,
} from "@/SQL/Migrations/index.ts";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { createHash } from "node:crypto";
import type { Client } from "pg";

const record = (name: string, sql: string): MigrationRecord => ({
  name,
  sql,
  hash: createHash("sha256").update(sql).digest("hex"),
  statements: [sql],
  createdAtMillis: undefined,
});
const users = record(
  "0001_users.sql",
  "CREATE TABLE users (id text PRIMARY KEY); ALTER TABLE users ADD COLUMN email text;",
);

/** A pg query seam backed by real SQLite SQL/history, with injectable failures. */
const database = (indexExists?: boolean) => {
  const db = new Database(":memory:");
  const calls: string[] = [];
  let reject: ((sql: string) => void) | undefined;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push(sql);
      reject?.(sql);
      if (sql.includes("information_schema.columns")) {
        const name = /table_name = '([^']+)'/.exec(sql)![1];
        return { rows: db.query(`PRAGMA table_info("${name}")`).all() };
      }
      if (/CREATE (UNIQUE )?INDEX ASYNC/.test(sql))
        return { rows: indexExists !== undefined ? [] : [{ job_id: "job-1" }] };
      if (sql.includes("FROM pg_index"))
        return { rows: [{ indisvalid: indexExists }] };
      if (sql.includes("FROM sys.jobs"))
        return { rows: [{ status: "completed" }] };
      const compatible = sql
        .replace(/\$(\d+)/g, "?$1")
        .replaceAll('"drizzle".', "")
        .replace(
          "uuid DEFAULT gen_random_uuid() PRIMARY KEY",
          "text PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))",
        )
        .replace(
          "timestamp with time zone DEFAULT now()",
          "text DEFAULT CURRENT_TIMESTAMP",
        );
      return {
        rows: db.query(compatible).all(...(params as SQLQueryBindings[])),
      };
    },
  } as unknown as Pick<Client, "query">;
  const executor = makeDsqlMigrationExecutor(client, "__alchemy_migrations");
  const apply = (records: MigrationRecord[]) =>
    withDsqlMigrationLock(
      executor,
      applyAlchemyFormat({ executor, table: "__alchemy_migrations", records }),
    );
  return {
    db,
    calls,
    executor,
    apply,
    reject: (fn?: (sql: string) => void) => {
      reject = fn;
    },
  };
};

test.effect(
  "DSQL applies multi-statement SQL separately and skips applied files",
  () =>
    Effect.gen(function* () {
      const target = database();
      yield* target.apply([users]);
      yield* target.apply([users]);
      expect(
        target.db.query("SELECT name, hash FROM __alchemy_migrations").all(),
      ).toEqual([{ name: users.name, hash: users.hash }]);
      expect(
        target.calls.filter((sql) => sql.startsWith("CREATE TABLE users")),
      ).toHaveLength(1);
      expect(
        target.calls.some((sql) =>
          /\b(BEGIN|COMMIT|ROLLBACK|SERIAL)\b/.test(sql),
        ),
      ).toBe(false);
      target.db.close();
    }),
);

test.effect("DSQL rejects changed history before running pending SQL", () =>
  Effect.gen(function* () {
    const target = database();
    yield* target.apply([users]);
    const result = yield* Effect.result(
      target.apply([
        record(users.name, users.sql + " -- edited"),
        record("0002_posts.sql", "CREATE TABLE posts(id text PRIMARY KEY)"),
      ]),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure.message).toContain("Expected SHA256");
    expect(
      target.calls.some((sql) => sql.startsWith("CREATE TABLE posts")),
    ).toBe(false);
    target.db.close();
  }),
);

test.effect(
  "DSQL resumes after a server-rejected statement without repeating committed DDL",
  () =>
    Effect.gen(function* () {
      const target = database();
      target.reject((sql) => {
        if (sql.startsWith("ALTER TABLE users"))
          throw Object.assign(new Error("denied"), {
            code: "42501",
            severity: "ERROR",
          });
      });
      expect(
        Result.isFailure(yield* Effect.result(target.apply([users]))),
      ).toBe(true);
      expect(
        target.db.query("SELECT * FROM __alchemy_migrations").all(),
      ).toHaveLength(0);
      target.reject();
      yield* target.apply([users]);
      expect(
        target.calls.filter((sql) => sql.startsWith("CREATE TABLE users")),
      ).toHaveLength(1);
      expect(
        target.db.query("SELECT * FROM __alchemy_migrations").all(),
      ).toHaveLength(1);
      target.db.close();
    }),
);

test.effect(
  "DSQL blocks ambiguous failures and changes to partially applied files",
  () =>
    Effect.gen(function* () {
      const target = database();
      target.reject((sql) => {
        if (sql.startsWith("ALTER TABLE users"))
          throw new Error("connection lost");
      });
      yield* Effect.result(target.apply([users]));
      target.reject();
      const ambiguous = yield* Effect.result(target.apply([users]));
      expect(Result.isFailure(ambiguous)).toBe(true);
      if (Result.isFailure(ambiguous))
        expect(ambiguous.failure.message).toContain("uncertain outcome");
      const changed = yield* Effect.result(
        target.apply([record(users.name, users.sql + " -- changed")]),
      );
      if (Result.isFailure(changed))
        expect(changed.failure.message).toContain("changed after it started");
      else throw new Error("Expected changed migration rejection");
      expect(
        target.calls.filter((sql) => sql.startsWith("ALTER TABLE users")),
      ).toHaveLength(1);
      target.db.close();
    }),
);

test.effect("DSQL waits for indexes before recording completion", () =>
  Effect.gen(function* () {
    const target = database();
    yield* target.apply([
      users,
      record(
        "0002_index.sql",
        'CREATE INDEX "email_idx" ON users USING btree(email);',
      ),
    ]);
    const index = target.calls.findIndex((sql) =>
      sql.startsWith("CREATE INDEX ASYNC"),
    );
    const wait = target.calls.findIndex((sql) => sql.includes("FROM sys.jobs"));
    const insert = target.calls.findIndex(
      (sql) =>
        sql.startsWith('INSERT INTO "__alchemy_migrations"') &&
        sql.includes("0002_index"),
    );
    expect(index).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(index);
    expect(insert).toBeGreaterThan(wait);
    target.db.close();
  }),
);

test.effect(
  "DSQL refuses a concurrent migrator and releases the lock after known failure",
  () =>
    Effect.gen(function* () {
      const target = database();
      yield* withDsqlMigrationLock(
        target.executor,
        Effect.gen(function* () {
          const concurrent = yield* Effect.result(target.apply([users]));
          expect(Result.isFailure(concurrent)).toBe(true);
          expect(
            target.calls.some((sql) => sql.startsWith("CREATE TABLE users")),
          ).toBe(false);
        }),
      );
      yield* Effect.result(
        withDsqlMigrationLock(
          target.executor,
          Effect.fail(new MigrationError({ message: "failure" })),
        ),
      );
      yield* target.apply([users]);
      target.db.close();
    }),
);

test.effect("DSQL resumes a persisted index job after a polling failure", () =>
  Effect.gen(function* () {
    const target = database();
    const indexed = record(
      "0002_index.sql",
      "CREATE INDEX email_idx ON users(email);",
    );
    target.reject((sql) => {
      if (sql.includes("FROM sys.jobs"))
        throw new Error("polling connection lost");
    });
    expect(
      Result.isFailure(yield* Effect.result(target.apply([users, indexed]))),
    ).toBe(true);
    expect(
      target.db.query("SELECT name FROM __alchemy_migrations").all(),
    ).toHaveLength(1);
    target.reject();
    yield* target.apply([users, indexed]);
    expect(
      target.calls.filter((sql) => sql.startsWith("CREATE INDEX ASYNC")),
    ).toHaveLength(1);
    expect(
      target.db.query("SELECT name FROM __alchemy_migrations").all(),
    ).toHaveLength(2);
    target.db.close();
  }),
);

test.effect(
  "DSQL refuses non-atomic conversion of existing foreign history",
  () =>
    Effect.gen(function* () {
      const target = database();
      target.db.exec(
        "CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY, hash text, created_at bigint, name text, applied_at text)",
      );
      target.db
        .query("INSERT INTO __drizzle_migrations (hash, name) VALUES (?, ?)")
        .run(users.hash, users.name);
      const result = yield* Effect.result(target.apply([users]));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure.message).toContain("without transactional DDL");
      expect(
        target.calls.some((sql) =>
          sql.startsWith('CREATE TABLE IF NOT EXISTS "__alchemy_migrations"'),
        ),
      ).toBe(false);
      target.db.close();
    }),
);

test.effect(
  "DSQL does not interpret application query results as index jobs",
  () =>
    Effect.gen(function* () {
      const target = database();
      yield* target.apply([
        record("0001_query.sql", "SELECT 'application-value' AS job_id;"),
      ]);
      expect(target.calls.some((sql) => sql.includes("FROM sys.jobs"))).toBe(
        false,
      );
      target.db.close();
    }),
);

for (const valid of [true, false]) {
  test.effect(
    `DSQL verifies an existing index's validity (${valid}) before recording a no-op`,
    () =>
      Effect.gen(function* () {
        const target = database(valid);
        const indexed = record(
          "0002_index.sql",
          'CREATE INDEX IF NOT EXISTS "email_idx" ON "public"."users"("email");',
        );
        const result = yield* Effect.result(target.apply([users, indexed]));
        expect(Result.isSuccess(result)).toBe(valid);
        expect(
          target.db.query("SELECT name FROM __alchemy_migrations").all(),
        ).toHaveLength(valid ? 2 : 1);
        target.db.close();
      }),
  );
}

test.effect(
  "DSQL fails closed when migration-history introspection fails",
  () =>
    Effect.gen(function* () {
      const target = database();
      target.reject((sql) => {
        if (sql.includes("information_schema.columns"))
          throw Object.assign(new Error("catalog denied"), {
            code: "42501",
            severity: "ERROR",
          });
      });
      const result = yield* Effect.result(target.apply([users]));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure.message).toContain("catalog denied");
      expect(
        target.calls.some((sql) =>
          sql.startsWith('CREATE TABLE IF NOT EXISTS "__alchemy_migrations"'),
        ),
      ).toBe(false);
      expect(
        target.calls.some((sql) => sql.startsWith("CREATE TABLE users")),
      ).toBe(false);
      target.db.close();
    }),
);

test.effect(
  "DSQL rejects an invalid recovery checkpoint instead of skipping pending SQL",
  () =>
    Effect.gen(function* () {
      const target = database();
      target.reject((sql) => {
        if (sql.startsWith("ALTER TABLE users"))
          throw new Error("connection lost");
      });
      yield* Effect.result(target.apply([users]));
      target.reject();
      target.db.exec(
        "UPDATE __alchemy_migrations__progress SET next_statement = 999, status = 'ready'",
      );
      const result = yield* Effect.result(target.apply([users]));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure.message).toContain("inconsistent progress");
      expect(
        target.db.query("SELECT * FROM __alchemy_migrations").all(),
      ).toHaveLength(0);
      target.db.close();
    }),
);
