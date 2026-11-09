import { describe, expect, it } from "@alchemy.run/test";
import { eq, SQL, sql } from "drizzle-orm";
import { integer, pgTable, QueryBuilder } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { proxyChain } from "@/Util/proxy-chain.ts";

const TIMEOUT = 5_000;

/**
 * A fake drizzle-like db. `select()` and `echo()` are real methods that
 * read `this` — so replaying them with the wrong receiver would throw,
 * which is how we assert `this`-binding is preserved through the proxy.
 */
const makeDb = () => ({
  greeting: "hi",
  echo(n: number) {
    return Effect.succeed(`${this.greeting}:${n}`);
  },
  select() {
    const greeting = this.greeting;
    return {
      from: (table: string) => Effect.succeed([`${greeting}/${table}`]),
    };
  },
});

type Db = ReturnType<typeof makeDb>;

describe("proxyChain", { tags: ["unit", "local"], timeout: 5000 }, () => {
  it.effect("replays a property-read + call chain when yielded", () =>
    Effect.gen(function* () {
      const db = proxyChain<Db>(Effect.succeed(makeDb()));
      const rows = yield* db.select().from("users");
      expect(rows).toEqual(["hi/users"]);
    }),
  );

  it.effect("binds `this` to the receiver for method calls", () =>
    Effect.gen(function* () {
      const db = proxyChain<Db>(Effect.succeed(makeDb()));
      // `echo` reads `this.greeting`; a dropped receiver would throw.
      const result = yield* db.echo(7);
      expect(result).toBe("hi:7");
    }),
  );

  it.effect("is lazy — does not resolve the underlying effect until yielded", () =>
    Effect.gen(function* () {
      let built = 0;
      const db = proxyChain<Db>(
        Effect.sync(() => {
          built++;
          return makeDb();
        }),
      );

      // Building the op chain must not touch the underlying effect.
      const query = db.select().from("users");
      expect(built).toBe(0);

      yield* query;
      expect(built).toBe(1);
    }),
  );

  it.effect("works as an Effect inside Effect.all (regression: used to hang)", () =>
    Effect.gen(function* () {
      const db = proxyChain<Db>(Effect.succeed(makeDb()));
      const results = yield* Effect.all([db.select().from("users"), db.select().from("posts")]);
      expect(results).toEqual([["hi/users"], ["hi/posts"]]);
    }),
  );

  it.effect("works inside Effect.forEach", () =>
    Effect.gen(function* () {
      const db = proxyChain<Db>(Effect.succeed(makeDb()));
      const results = yield* Effect.forEach(["users", "posts", "comments"], (table) =>
        db.select().from(table),
      );
      expect(results).toEqual([["hi/users"], ["hi/posts"], ["hi/comments"]]);
    }),
  );

  it.effect("supports `.pipe` on a chain (forwarded to the resolved effect)", () =>
    Effect.gen(function* () {
      const db = proxyChain<Db>(Effect.succeed(makeDb()));
      const rows = yield* db
        .select()
        .from("users")
        .pipe(Effect.map((rows) => rows.map((r) => r.toUpperCase())));
      expect(rows).toEqual(["HI/USERS"]);
    }),
  );

  it.effect("supports `.pipe` recovering a failure", () =>
    Effect.gen(function* () {
      const db = proxyChain<{ boom: () => Effect.Effect<string, string> }>(
        Effect.succeed({ boom: () => Effect.fail("nope") }),
      );
      const result = yield* db.boom().pipe(Effect.catch((e) => Effect.succeed(`recovered:${e}`)));
      expect(result).toBe("recovered:nope");
    }),
  );

  it.effect("is recognized by predicate-dispatched Effect operators", () =>
    Effect.gen(function* () {
      const api = proxyChain(
        Effect.succeed({
          transaction: () => Effect.fail({ _tag: "TestError" } as const),
        }),
      );

      const transaction = api.transaction();

      expect(Effect.isEffect(transaction)).toBe(true);

      const result = yield* transaction.pipe(
        Effect.catchTag("TestError", () => Effect.succeed("recovered")),
      );

      expect(result).toBe("recovered");
    }),
  );

  /**
   * effect ≥ 4.0.0-rc.113's generator runner asks `value[ExitTypeId] !==
   * undefined` to tell an Exit from an Effect. If the proxy answered that
   * brand probe with a chain step, every `yield*` would resume with the
   * proxy itself instead of the query result (the bug behind `users.length`
   * serializing as `{ _id: "Effect", op: "OnSuccess" }`).
   */
  it.effect("does not record Effect brand probes as chain steps", () =>
    Effect.gen(function* () {
      const db = proxyChain<Db>(Effect.succeed(makeDb()));
      const query = db.select().from("users") as unknown as Record<PropertyKey, unknown>;
      expect(query["~effect/Exit"]).toBeUndefined();
      expect(Exit.isExit(query)).toBe(false);
      expect(Effect.isEffect(query)).toBe(true);
      // Symbols the runtime does not define on an Effect are absent too.
      expect(query[Symbol.for("some/unrelated/probe")]).toBeUndefined();
      // …and the chain still resolves to the real value when yielded.
      const rows = yield* db.select().from("users");
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toEqual(["hi/users"]);
    }),
  );

  it.effect("a `.pipe`-d chain still composes inside Effect.all", () =>
    Effect.gen(function* () {
      const db = proxyChain<Db>(Effect.succeed(makeDb()));
      const results = yield* Effect.all([
        db
          .select()
          .from("users")
          .pipe(Effect.map((r) => r.length)),
        db
          .select()
          .from("posts")
          .pipe(Effect.map((r) => r.length)),
      ]);
      expect(results).toEqual([1, 1]);
    }),
  );

  it.effect("propagates failures from the resolved effect", () =>
    Effect.gen(function* () {
      const db = proxyChain<{ boom: () => Effect.Effect<never, string> }>(
        Effect.succeed({ boom: () => Effect.fail("nope") }),
      );
      const error = yield* Effect.flip(db.boom());
      expect(error).toBe("nope");
    }),
  );

  it.effect("propagates failures from the underlying (cached) effect", () =>
    Effect.gen(function* () {
      const db = proxyChain<Db>(Effect.fail("connect failed"));
      const error = yield* Effect.flip(db.select().from("users"));
      expect(error).toBe("connect failed");
    }),
  );

  /**
   * A fake `@effect/sql`-like client: a tagged-template function with
   * synchronous fragment helpers (`insert`, `and`) hanging off it — the shape
   * that surfaced the nested-proxy bug (`sql.insert(row)` inside an outer
   * `` sql`...` `` template was passed to the real client as a proxy, which
   * D1 then tried to bind as a parameter).
   */
  const makeSql = () => {
    const render = (v: unknown): string =>
      typeof v === "string" && v.startsWith("frag:")
        ? v.slice("frag:".length)
        : typeof v === "function"
          ? "?fn"
          : `?${JSON.stringify(v)}`;
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) =>
      Effect.succeed(
        strings.reduce((acc, s, i) => acc + s + (i < values.length ? render(values[i]) : ""), ""),
      );
    sql.insert = (row: Record<string, unknown>) =>
      `frag:(${Object.keys(row).join(",")}) VALUES (${Object.values(row).join(",")})`;
    sql.and = (parts: unknown[]) => `frag:(${parts.map(render).join(" AND ")})`;
    return sql;
  };

  type Sql = ReturnType<typeof makeSql>;

  describe("nested chains as call arguments", () => {
    it.effect("replays a nested chain argument against the same root (sql.insert)", () =>
      Effect.gen(function* () {
        const sql = proxyChain<Sql>(Effect.succeed(makeSql()));
        const query = yield* sql`INSERT INTO users ${sql.insert({ id: 1, name: "'alice'" })}`;
        expect(query).toBe("INSERT INTO users (id,name) VALUES (1,'alice')");
      }),
    );

    it.effect("replays nested chains inside array arguments (sql.and)", () =>
      Effect.gen(function* () {
        const sql = proxyChain<Sql>(Effect.succeed(makeSql()));
        const query = yield* sql`SELECT * FROM users WHERE ${sql.and([
          sql.insert({ a: 1 }),
          sql.insert({ b: 2 }),
        ])}`;
        expect(query).toBe("SELECT * FROM users WHERE ((a) VALUES (1) AND (b) VALUES (2))");
      }),
    );

    it.effect("leaves plain values and non-chain objects untouched", () =>
      Effect.gen(function* () {
        const sql = proxyChain<Sql>(Effect.succeed(makeSql()));
        const query = yield* sql`SELECT ${42} FROM ${{ obj: true }}`;
        expect(query).toBe('SELECT ?42 FROM ?{"obj":true}');
      }),
    );

    it.effect("resolves the underlying effect exactly once for outer + nested chains", () =>
      Effect.gen(function* () {
        let built = 0;
        const sql = proxyChain<Sql>(
          Effect.sync(() => {
            built++;
            return makeSql();
          }),
        );
        const query = sql`INSERT INTO t ${sql.insert({ x: 9 })}`;
        // Building the composite chain must not resolve anything…
        expect(built).toBe(0);
        yield* query;
        // …and the nested chain reuses the outer chain's resolved root.
        expect(built).toBe(1);
      }),
    );

    it.effect("leaves a chain over a *different* underlying effect untouched", () =>
      Effect.gen(function* () {
        const sqlA = proxyChain<Sql>(Effect.succeed(makeSql()));
        const other = proxyChain<Db>(Effect.succeed(makeDb()));
        // `other.select()` is a proxy over a different cached effect — it
        // can't be replayed synchronously, so it must pass through as-is
        // (rendered as an opaque bind value by the fake client).
        const query = yield* sqlA`SELECT ${other.select()}`;
        expect(query).toBe("SELECT ?fn");
      }),
    );

    it.effect("walks only objects `descend` accepts", () =>
      Effect.gen(function* () {
        const root = { x: 5, put: (v: unknown) => Effect.succeed(v) };
        const plain = proxyChain(Effect.succeed(root));
        const x = plain.x;
        const arg = { n: x };
        const out = (yield* plain.put(arg)) as typeof arg;
        expect(out).toBe(arg);
        expect(out.n).toBe(x);

        const db = proxyChain(Effect.succeed(root), { descend: descendDrizzle });
        expect(yield* db.put({ n: db.x })).toEqual({ n: 5 });
      }),
    );

    it.effect("keeps the prototype of a walked object it copies", () =>
      Effect.gen(function* () {
        const db = proxyChain(Effect.succeed({ x: 5, put: (v: SQL) => Effect.succeed(v) }), {
          descend: descendDrizzle,
        });
        const chunk = sql`count(${db.x})`;
        const out = yield* db.put(chunk);
        expect(out).not.toBe(chunk);
        expect(out).toBeInstanceOf(SQL);
        expect(out.queryChunks).toContain(5);
      }),
    );

    it.effect("leaves binary data and other classes alone", () =>
      Effect.gen(function* () {
        class Box {
          #v = 1;
          constructor(readonly inner: unknown) {}
          get v() {
            return this.#v;
          }
        }
        const db = proxyChain(Effect.succeed({ x: 5, put: (v: unknown) => Effect.succeed(v) }), {
          descend: descendDrizzle,
        });
        const bytes = new Uint8Array(1_000_000);
        expect(yield* db.put(bytes)).toBe(bytes);
        const box = new Box(db.x);
        const out = (yield* db.put(box)) as Box;
        expect(out).toBe(box);
        expect(out.v).toBe(1);
      }),
    );

    it.effect("survives an array that contains itself", () =>
      Effect.gen(function* () {
        const db = proxyChain(Effect.succeed({ put: (v: unknown) => Effect.succeed(v) }), {
          descend: descendDrizzle,
        });
        const cyclic: unknown[] = [];
        cyclic.push(cyclic);
        expect(yield* db.put(cyclic)).toBe(cyclic);
      }),
    );

    it.effect("resolves a CTE column nested in a drizzle aggregate and join", () =>
      Effect.gen(function* () {
        const rows = pgTable("repro_rows", {
          id: integer("id"),
          parent: integer("parent"),
        });
        const query = <Q extends QueryBuilder>(qb: Q) => {
          const cte = qb.$with("c").as(qb.select().from(rows));
          return qb
            .with(cte)
            .select({ id: rows.id, n: sql`count(${cte.id})`.mapWith(Number) })
            .from(rows)
            .leftJoin(cte, eq(cte.parent, rows.id))
            .groupBy(rows.id);
        };
        const expected = query(new QueryBuilder()).toSQL();

        // A QueryBuilder whose `done(query)` ends the chain as an Effect, so
        // the whole query is built from deferred proxies and replayed.
        const root = Object.assign(new QueryBuilder(), {
          done: (q: { toSQL(): unknown }) => Effect.sync(() => q.toSQL()),
        });
        const db = proxyChain(Effect.succeed(root), { descend: descendDrizzle });
        expect(yield* db.done(query(db))).toEqual(expected);
      }),
    );

    it.effect("resolves a CTE column returned from a drizzle callback", () =>
      Effect.gen(function* () {
        const rows = pgTable("repro_rows", {
          id: integer("id"),
          parent: integer("parent"),
        });
        const query = <Q extends QueryBuilder>(qb: Q) => {
          const cte = qb.$with("c").as(qb.select().from(rows));
          return qb
            .with(cte)
            .select({ id: rows.id })
            .from(rows)
            .leftJoin(cte, () => eq(cte.parent, rows.id))
            .where(() => eq(cte.id, rows.id));
        };
        const expected = query(new QueryBuilder()).toSQL();

        const root = Object.assign(new QueryBuilder(), {
          done: (q: { toSQL(): unknown }) => Effect.sync(() => q.toSQL()),
        });
        const db = proxyChain(Effect.succeed(root), { descend: descendDrizzle });
        expect(yield* db.done(query(db))).toEqual(expected);
      }),
    );

    it.effect("leaves a callback's returned query and its client intact", () =>
      Effect.gen(function* () {
        // Shape of `db.transaction((tx) => tx.query.rows.findMany())`: the
        // returned builder holds a session whose client is callable and has
        // its own methods (`client.unsafe`).
        class Query {
          constructor(readonly session: { client: (() => void) & { unsafe: () => string } }) {}
        }
        Object.defineProperty(Query, Symbol.for("drizzle:entityKind"), {
          value: "SQLiteRelationalQuery",
        });
        const client = Object.assign(() => {}, { unsafe: () => "ok" });
        const query = new Query({ client });
        const db = proxyChain(
          Effect.succeed({
            transaction: (cb: (tx: unknown) => Query) =>
              Effect.sync(() => cb({}).session.client.unsafe()),
          }),
          { descend: descendDrizzle },
        );
        expect(yield* db.transaction(() => query)).toBe("ok");
      }),
    );

    it.effect("keeps a wrapped callback's own properties", () =>
      Effect.gen(function* () {
        const cb = Object.assign(() => 1, { unsafe: () => "ok" });
        const db = proxyChain(
          Effect.succeed({ put: (f: typeof cb) => Effect.sync(() => [f(), f.unsafe()]) }),
          { descend: descendDrizzle },
        );
        expect(yield* db.put(cb)).toEqual([1, "ok"]);
      }),
    );

    it.effect("leaves a decoder on a drizzle SQL object unwrapped", () =>
      Effect.gen(function* () {
        const decode = (v: unknown) => Number(v);
        const chunk = sql`1`.mapWith(decode);
        const db = proxyChain(Effect.succeed({ put: (v: SQL) => Effect.succeed(v) }), {
          descend: descendDrizzle,
        });
        const out = yield* db.put(chunk);
        expect(out).toBe(chunk);
        expect(Reflect.get(out, "decoder").mapFromDriverValue).toBe(decode);
      }),
    );

    it.effect("does not walk drizzle tables or columns", () =>
      Effect.gen(function* () {
        const rows = pgTable("repro_rows", { id: integer("id") });
        expect(descendDrizzle(rows)).toBe(false);
        expect(descendDrizzle(rows.id)).toBe(false);
        expect(descendDrizzle(new QueryBuilder().select().from(rows))).toBe(false);
        expect(descendDrizzle(sql`1`)).toBe(true);
      }),
    );
  });
});

const entityKind = Symbol.for("drizzle:entityKind");

/**
 * The SQL building blocks a deferred column can hide in. Everything else
 * (tables, columns, query builders, sessions) is left alone: schema is built
 * at module scope, and builders and sessions hold the live client.
 */
const sqlKinds = new Set(["SQL", "SQL.Aliased", "Param", "ValueRows"]);

const walkable = new WeakMap<Function, boolean>();

const isSqlEntity = (ctor: Function): boolean => {
  let result = walkable.get(ctor);
  if (result === undefined) {
    result = false;
    for (let cls: any = ctor; cls; cls = Object.getPrototypeOf(cls)) {
      if (Object.hasOwn(cls, entityKind) && sqlKinds.has(cls[entityKind])) {
        result = true;
        break;
      }
    }
    walkable.set(ctor, result);
  }
  return result;
};

/** Mirrors `descendDrizzle` in `@alchemy.run/drizzle`. */
const descendDrizzle = (value: object): boolean => {
  if (typeof value === "function") return !(entityKind in value);
  const proto = Object.getPrototypeOf(value);
  if (proto === null || proto === Object.prototype) return true;
  const ctor = proto.constructor;
  return typeof ctor === "function" && isSqlEntity(ctor);
};
