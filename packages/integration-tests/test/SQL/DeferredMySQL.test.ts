import * as Docker from "@alchemy.run/docker";
import * as Drizzle from "@alchemy.run/drizzle/MySQL";
import * as SQL from "@alchemy.run/sql/MySQL";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { inMemoryState } from "alchemy/State";
import { eq, sql as fragment } from "drizzle-orm";
import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });

const items = mysqlTable("items", {
  id: int("id").primaryKey(),
  parent: int("parent"),
  label: varchar("label", { length: 64 }).notNull().default(""),
});

class Abort extends Data.TaggedError("Abort")<{}> {}

// What a Runtime bridge does for one event: a fresh `Scope`, closed when the
// handler settles.
const execution = Effect.scoped;

const PASSWORD = "alchemy";
const DATABASE = "app";

/**
 * `SQL.MySQL` and `Drizzle.MySQL` against MySQL in Docker: the clients are
 * built before the database is reachable, and each execution opens its own
 * pool. The live suite (`MySQL.test.ts`) runs the same clients on a Worker
 * behind Hyperdrive.
 */
test.provider(
  "SQL.MySQL and Drizzle.MySQL build at Construction phase and connect per execution",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const container = yield* stack.deploy(
        Docker.Container("mysql", {
          image: "mysql:8.0",
          environment: { MYSQL_ROOT_PASSWORD: PASSWORD, MYSQL_DATABASE: DATABASE },
          ports: [{ external: 0, internal: 3306 }],
          start: true,
        }),
      );
      const port = container.ports["3306/tcp"];
      expect(port).toEqual(expect.any(Number));

      // `connects` counts how many times a client resolved the URL, which it
      // does once per pool it opens.
      const counter = { connects: 0 };
      const url = Effect.sync(() => {
        counter.connects++;
        return Redacted.make(`mysql://root:${PASSWORD}@127.0.0.1:${port}/${DATABASE}`);
      });

      // Built once, outside any execution, as a Runtime does.
      const sql = yield* SQL.MySQL({ url });
      const db = yield* Drizzle.MySQL(url);
      const children = db.$with("c").as(db.select().from(items));
      const counts = db
        .with(children)
        .select({ id: items.id, n: fragment<number>`count(${children.id})`.mapWith(Number) })
        .from(items)
        .leftJoin(children, eq(children.parent, items.id))
        .groupBy(items.id)
        .orderBy(items.id);

      const [text, params] = sql`SELECT * FROM ${sql("items")} WHERE ${sql.and([
        sql`id = ${1}`,
        sql`parent IS NULL`,
      ])}`.compile();
      expect(text).toBe("SELECT * FROM `items` WHERE (id = ? AND parent IS NULL)");
      expect(params).toEqual([1]);
      // alchemy-run/alchemy#2001: the CTE column is in the aggregate and the join.
      expect(counts.toSQL().sql).toContain("count(`c`.`id`)");
      expect(counts.toSQL().sql).toContain("on `c`.`parent` = `items`.`id`");
      expect(counter.connects).toBe(0);

      // The image starts a temporary server to initialize the database, then
      // restarts: retry until the real one accepts the login.
      yield* execution(sql`SELECT 1`).pipe(
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 40 }),
      );

      yield* execution(
        Effect.gen(function* () {
          yield* sql`CREATE TABLE items (id INT PRIMARY KEY, parent INT, label VARCHAR(64) NOT NULL DEFAULT '')`;
          yield* sql`INSERT INTO items ${sql.insert([
            { id: 1, parent: null, label: "root" },
            { id: 2, parent: 1, label: "a" },
            { id: 3, parent: 1, label: "b" },
          ])}`;
        }),
      );

      const labels = sql<{ label: string }>`SELECT label FROM items ORDER BY id`.pipe(
        Effect.map((found) => found.map((row) => row.label)),
      );

      // One pool per execution, shared by every statement and transaction in it.
      const before = counter.connects;
      const events: string[] = [];
      const afterTransactions = yield* execution(
        Effect.gen(function* () {
          yield* sql`UPDATE items SET ${sql.update({ label: "renamed" })} WHERE id = ${2}`;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE items SET label = 'committed' WHERE id = 1`;
              yield* sql.afterCommit(Effect.sync(() => events.push("after commit")));
              // A savepoint that rolls back leaves the outer transaction intact.
              yield* sql
                .withTransaction(
                  Effect.gen(function* () {
                    yield* sql`UPDATE items SET label = 'savepoint' WHERE id = 3`;
                    return yield* new Abort();
                  }),
                )
                .pipe(Effect.catchTag("Abort", () => Effect.void));
              events.push((yield* labels).join(","));
            }),
          );
          const rolledBack = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE items SET label = 'lost' WHERE id = 3`;
                return yield* new Abort();
              }),
            )
            .pipe(Effect.exit);
          expect(Exit.isFailure(rolledBack)).toBe(true);
          return yield* labels;
        }),
      );
      expect(afterTransactions).toEqual(["committed", "renamed", "b"]);
      expect(events).toEqual(["committed,renamed,b", "after commit"]);
      expect(counter.connects).toBe(before + 1);

      // A stream opens its own client, for as long as it runs.
      const streamed = yield* Stream.runCollect(
        sql<{ id: number }>`SELECT id FROM items ORDER BY id`.stream,
      );
      expect(Array.from(streamed).map((row) => row.id)).toEqual([1, 2, 3]);

      // The drizzle query built before the database existed.
      expect(yield* execution(counts)).toEqual([
        { id: 1, n: 2 },
        { id: 2, n: 0 },
        { id: 3, n: 0 },
      ]);

      const drizzleLabels = yield* execution(
        Effect.gen(function* () {
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert(items).values({ id: 4, parent: 3, label: "kept" });
              yield* tx.update(items).set({ label: "updated" }).where(eq(items.id, 1));
            }),
          );
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.insert(items).values({ id: 5, label: "lost" });
                return yield* new Abort();
              }),
            )
            .pipe(Effect.catchTag("Abort", () => Effect.void));
          const found = yield* db.select({ label: items.label }).from(items).orderBy(items.id);
          return found.map((row) => row.label);
        }),
      );
      expect(drizzleLabels).toEqual(["updated", "renamed", "b", "kept"]);

      yield* stack.destroy();
    }),
  { tags: ["provider:docker", "provider:docker:container", "local"], timeout: 240_000 },
);
