import * as Drizzle from "@alchemy.run/drizzle/LibSQL";
import * as SQL from "@alchemy.run/sql/SQLite";
import { expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { eq, sql as fragment } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const rows = sqliteTable("rows", {
  id: integer("id").primaryKey(),
  parent: integer("parent"),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
  label: text("label").notNull().default(""),
});

class NoDatabase extends Data.TaggedError("NoDatabase")<{}> {}

// What a Runtime bridge does for one event: a fresh `Scope`, closed when the
// handler settles.
const execution = Effect.scoped;

// A libSQL `file:` database in a temp directory. An in-memory database would
// be a new, empty one in every execution. `connects` counts how many times a
// client resolved the URL, which it does once per client it opens.
const makeDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-deferred-client-" });
  const url = `file:${path.join(dir, "test.db")}`;
  const counter = { connects: 0 };
  const source = {
    url: Effect.sync(() => {
      counter.connects++;
      return url;
    }),
  };
  return { source, counter };
});

const createRows = (sql: Effect.Success<ReturnType<typeof SQL.LibSQL>>) =>
  execution(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE rows (id INTEGER PRIMARY KEY, parent INTEGER, done INTEGER NOT NULL DEFAULT 0, label TEXT NOT NULL DEFAULT '')`;
      yield* sql`INSERT INTO rows ${sql.insert([
        { id: 1, parent: null, done: 1, label: "root" },
        { id: 2, parent: 1, done: 0, label: "a" },
        { id: 3, parent: 1, done: 1, label: "b" },
      ])}`;
    }),
  );

const withNode = layer(NodeServices.layer);

withNode("DeferredClient", (it) => {
  it.effect(
    "builds and compiles statements at Construction phase without connecting",
    () =>
      Effect.gen(function* () {
        const { source, counter } = yield* makeDatabase;
        const sql = yield* SQL.LibSQL(source);
        const db = yield* Drizzle.LibSQL(source);

        const [text, params] = sql`SELECT * FROM rows WHERE ${sql.and([
          sql`id = ${1}`,
          sql`parent IS NULL`,
        ])}`.compile();
        expect(text).toBe("SELECT * FROM rows WHERE (id = ? AND parent IS NULL)");
        expect(params).toEqual([1]);

        const cte = db.$with("c").as(db.select().from(rows));
        const query = db
          .with(cte)
          .select({ n: fragment<number>`count(${cte.id})` })
          .from(cte)
          .toSQL();
        expect(query.sql).toContain('count("c"."id")');

        expect(counter.connects).toBe(0);
      }),
    { tags: ["local"] },
  );

  it.effect(
    "opens one client per execution and closes it with the execution",
    () =>
      Effect.gen(function* () {
        const { source, counter } = yield* makeDatabase;
        const sql = yield* SQL.LibSQL(source);
        yield* createRows(sql);
        expect(counter.connects).toBe(1);

        const first = yield* execution(
          Effect.gen(function* () {
            const a = yield* sql<{ id: number }>`SELECT id FROM rows WHERE id = ${1}`;
            const b = yield* sql<{ id: number }>`SELECT id FROM rows WHERE id = ${2}`;
            return [...a, ...b].map((row) => row.id);
          }),
        );
        expect(first).toEqual([1, 2]);
        expect(counter.connects).toBe(2);

        yield* execution(Effect.all([sql`SELECT 1`, sql`SELECT 2`], { concurrency: 2 }));
        expect(counter.connects).toBe(3);
      }),
    { tags: ["local"] },
  );

  it.effect(
    "composes a fragment helper inside a statement",
    () =>
      Effect.gen(function* () {
        const { source } = yield* makeDatabase;
        const sql = yield* SQL.LibSQL(source);
        yield* createRows(sql);

        const found = yield* execution(
          Effect.gen(function* () {
            yield* sql`INSERT INTO rows ${sql.insert({ id: 4, parent: 2, done: 0, label: "c" })}`;
            yield* sql`UPDATE rows SET ${sql.update({ label: "renamed" })} WHERE id = ${4}`;
            const matched = yield* sql<{
              id: number;
              label: string;
            }>`SELECT id, label FROM rows WHERE ${sql.in("id", [3, 4])} ORDER BY id`;
            // A libSQL row is not a plain object.
            return matched.map((row) => ({ id: row.id, label: row.label }));
          }),
        );
        expect(found).toEqual([
          { id: 3, label: "b" },
          { id: 4, label: "renamed" },
        ]);
      }),
    { tags: ["local"] },
  );

  it.effect(
    "transforms names once, in the deferred client",
    () =>
      Effect.gen(function* () {
        const { source } = yield* makeDatabase;
        const plain = yield* SQL.LibSQL(source);
        yield* execution(
          plain`CREATE TABLE people (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL)`,
        );
        const sql = yield* SQL.LibSQL(source, {
          transformQueryNames: (name) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
          transformResultNames: (name) =>
            name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
        });

        const people = yield* execution(
          Effect.gen(function* () {
            yield* sql`INSERT INTO people ${sql.insert({ id: 1, firstName: "Ada" })}`;
            return yield* sql`SELECT * FROM people`;
          }),
        );
        expect(people).toEqual([{ id: 1, firstName: "Ada" }]);
      }),
    { tags: ["local"] },
  );

  it.effect(
    "runs a transaction on one connection: commit, rollback, savepoint, afterCommit",
    () =>
      Effect.gen(function* () {
        const { source, counter } = yield* makeDatabase;
        const sql = yield* SQL.LibSQL(source);
        yield* createRows(sql);
        const labels = sql<{ label: string }>`SELECT label FROM rows ORDER BY id`.pipe(
          Effect.map((found) => found.map((row) => row.label)),
        );

        const events: string[] = [];
        const before = counter.connects;
        const result = yield* execution(
          Effect.gen(function* () {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE rows SET label = 'committed' WHERE id = 1`;
                yield* sql.afterCommit(Effect.sync(() => events.push("after commit")));
                // A savepoint that rolls back leaves the outer transaction intact.
                yield* sql
                  .withTransaction(
                    Effect.gen(function* () {
                      yield* sql`UPDATE rows SET label = 'savepoint' WHERE id = 2`;
                      return yield* new NoDatabase();
                    }),
                  )
                  .pipe(Effect.catchTag("NoDatabase", () => Effect.void));
                // A statement in the transaction sees its own writes.
                events.push((yield* labels).join(","));
              }),
            );
            events.push("committed");

            const rolledBack = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`UPDATE rows SET label = 'lost' WHERE id = 3`;
                  yield* sql.afterCommit(Effect.sync(() => events.push("never")));
                  return yield* new NoDatabase();
                }),
              )
              .pipe(Effect.exit);
            expect(Exit.isFailure(rolledBack)).toBe(true);
            return yield* labels;
          }),
        );

        expect(result).toEqual(["committed", "a", "b"]);
        expect(events).toEqual(["committed,a,b", "after commit", "committed"]);
        // The transactions and the statements around them shared the execution's client.
        expect(counter.connects).toBe(before + 1);
      }),
    { tags: ["local"] },
  );

  // alchemy-run/alchemy#2001: a CTE column inside `sql` and `eq` used to reach
  // drizzle unresolved, producing `count()` and `on  = `.
  it.effect(
    "drizzle: a CTE column in an aggregate and a join",
    () =>
      Effect.gen(function* () {
        const { source, counter } = yield* makeDatabase;
        const sql = yield* SQL.LibSQL(source);
        const db = yield* Drizzle.LibSQL(source);
        yield* createRows(sql);

        // Built once, outside any execution.
        const children = db.$with("c").as(db.select().from(rows));
        const counts = db
          .with(children)
          .select({ id: rows.id, n: fragment<number>`count(${children.id})`.mapWith(Number) })
          .from(rows)
          .leftJoin(children, eq(children.parent, rows.id))
          .groupBy(rows.id)
          .orderBy(rows.id);

        const before = counter.connects;
        expect(yield* execution(counts)).toEqual([
          { id: 1, n: 2 },
          { id: 2, n: 0 },
          { id: 3, n: 0 },
        ]);
        expect(yield* execution(counts)).toEqual([
          { id: 1, n: 2 },
          { id: 2, n: 0 },
          { id: 3, n: 0 },
        ]);
        expect(counter.connects).toBe(before + 2);
      }),
    { tags: ["local"] },
  );

  it.effect(
    "drizzle: a CTE column encodes its value, and a CTE reads another in a callback",
    () =>
      Effect.gen(function* () {
        const { source } = yield* makeDatabase;
        const sql = yield* SQL.LibSQL(source);
        const db = yield* Drizzle.LibSQL(source);
        yield* createRows(sql);

        const all = db.$with("all_rows").as(db.select().from(rows));
        // `done` is stored as 0/1: the comparison must bind 1, not `true`.
        const finished = db
          .$with("finished")
          .as((qb) => qb.select().from(all).where(eq(all.done, true)));
        const query = db
          .with(all, finished)
          .select({ id: finished.id, done: finished.done })
          .from(finished)
          .where(() => eq(finished.done, true))
          .orderBy(finished.id);
        expect(query.toSQL().params).toEqual([1, 1]);

        expect(yield* execution(query)).toEqual([
          { id: 1, done: true },
          { id: 3, done: true },
        ]);
      }),
    { tags: ["local"] },
  );

  it.effect(
    "drizzle: a transaction commits and rolls back",
    () =>
      Effect.gen(function* () {
        const { source, counter } = yield* makeDatabase;
        const sql = yield* SQL.LibSQL(source);
        const db = yield* Drizzle.LibSQL(source);
        yield* createRows(sql);

        const before = counter.connects;
        const labels = yield* execution(
          Effect.gen(function* () {
            yield* db.transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.insert(rows).values({ id: 4, parent: 3, label: "kept" });
                yield* tx.update(rows).set({ label: "updated" }).where(eq(rows.id, 1));
              }),
            );
            yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  yield* tx.insert(rows).values({ id: 5, label: "lost" });
                  return yield* new NoDatabase();
                }),
              )
              .pipe(Effect.catchTag("NoDatabase", () => Effect.void));
            const found = yield* db.select({ label: rows.label }).from(rows).orderBy(rows.id);
            return found.map((row) => row.label);
          }),
        );
        expect(labels).toEqual(["updated", "a", "b", "kept"]);
        expect(counter.connects).toBe(before + 1);
      }),
    { tags: ["local"] },
  );

  it.effect(
    "a connection source that fails is a SqlError on the statement",
    () =>
      Effect.gen(function* () {
        const sql = yield* SQL.LibSQL({ url: Effect.fail(new NoDatabase()) });
        const error = yield* execution(sql`SELECT 1`).pipe(Effect.flip);
        expect(error._tag).toBe("SqlError");
        expect(error.reason._tag).toBe("ConnectionError");
        expect(error.reason.cause).toBeInstanceOf(NoDatabase);
      }),
    { tags: ["local"] },
  );

  it.effect(
    "running a statement outside an execution is a defect",
    () =>
      Effect.gen(function* () {
        const { source, counter } = yield* makeDatabase;
        const sql = yield* SQL.LibSQL(source);
        const exit = yield* Effect.promise(() => Effect.runPromiseExit(sql`SELECT 1`));
        expect(Exit.hasDies(exit)).toBe(true);
        expect(counter.connects).toBe(0);
      }),
    { tags: ["local"] },
  );
});
