import { proxyChain } from "@/Util/proxy-chain.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

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

describe("proxyChain", () => {
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

  it.effect(
    "is lazy — does not resolve the underlying effect until yielded",
    () =>
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

  it.effect(
    "works as an Effect inside Effect.all (regression: used to hang)",
    () =>
      Effect.gen(function* () {
        const db = proxyChain<Db>(Effect.succeed(makeDb()));
        const results = yield* Effect.all([
          db.select().from("users"),
          db.select().from("posts"),
        ]);
        expect(results).toEqual([["hi/users"], ["hi/posts"]]);
      }),
  );

  it.effect("works inside Effect.forEach", () =>
    Effect.gen(function* () {
      const db = proxyChain<Db>(Effect.succeed(makeDb()));
      const results = yield* Effect.forEach(
        ["users", "posts", "comments"],
        (table) => db.select().from(table),
      );
      expect(results).toEqual([["hi/users"], ["hi/posts"], ["hi/comments"]]);
    }),
  );

  it.effect(
    "supports `.pipe` on a chain (forwarded to the resolved effect)",
    () =>
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
      const result = yield* db
        .boom()
        .pipe(Effect.catch((e) => Effect.succeed(`recovered:${e}`)));
      expect(result).toBe("recovered:nope");
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
}, 5000);
