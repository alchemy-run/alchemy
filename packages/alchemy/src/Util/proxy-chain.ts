/** @effect-diagnostics anyUnknownInErrorContext:off */
import * as Effect from "effect/Effect";

type Op =
  | { kind: "get"; prop: PropertyKey }
  | { kind: "call"; args: unknown[] };

/**
 * Replay an op chain against a real value. `get` reads a property,
 * `call` invokes — bound to the previous receiver so `this` resolves
 * to the object the method was read from (drizzle's `select()` etc.
 * read `this._.session`, so dropping `this` would throw).
 */
const replay = (root: unknown, ops: ReadonlyArray<Op>): unknown => {
  let cur: any = root;
  let receiver: any = root;
  for (const op of ops) {
    if (op.kind === "get") {
      receiver = cur;
      cur = cur[op.prop];
    } else {
      cur = cur.apply(receiver, op.args);
      receiver = cur;
    }
  }
  return cur;
};

/**
 * Wrap a cached `Effect<T>` in a chainable Proxy so callers can use the
 * returned value as if it were `T` itself — every property read and call
 * records a step, and the chain is replayed against the resolved value
 * when it's finally yielded as an Effect.
 *
 * Compare:
 *
 * ```typescript
 * // Without proxyChain — caller has to yield the cached Effect first:
 * const conn = yield* makeConnection();      // Effect<Db>
 * fetch: Effect.gen(function* () {
 *   const db = yield* conn;
 *   const rows = yield* db.select().from(users);
 * });
 *
 * // With proxyChain — caller treats the return as the value directly:
 * const db = proxyChain(yield* Effect.cached(makeDb));   // T
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.select().from(users);
 * });
 * ```
 *
 * The chain ends when the proxy is yielded as an Effect — the resolved
 * value at that point must be a `Yieldable` (an Effect, drizzle query
 * builder, etc). Anything before that is recorded as ops.
 *
 * The cached effect must be channel-free (`Effect<T>`). The handle's
 * type is exactly `T`, yet yielding a chain evaluates the cached effect
 * first — so an error or requirement channel on it would be erased from
 * the types while still live at runtime. Widening `T` instead is not an
 * option: rebuilding method signatures structurally collapses generic
 * inference (drizzle's `select()`, sql's tagged template). So channels
 * are rejected at the call site — discharge them first:
 *
 * ```typescript
 * // ❌ won't compile — PgClient.make is
 * //    Effect<PgClient, SqlError, Scope | Reactivity>, and the handle
 * //    would silently erase all three:
 * const sql = proxyChain(PgClient.make({ url }));
 *
 * // ✅ discharge the channels: provide requirements, surface errors,
 * //    and defer Scope to the per-event execution scope (which also
 * //    memoizes the pool per event):
 * const sql = proxyChain(
 *   yield* makeExecutionMemo(
 *     PgClient.make({ url }).pipe(
 *       Effect.provide(Reactivity.layer),
 *       Effect.orDie,
 *     ),
 *   ),
 * );
 * ```
 */
export const proxyChain = <T>(cached: Effect.Effect<T>): T =>
  chain(cached) as T;

const chain = (
  cached: Effect.Effect<unknown, any, any>,
  ops: ReadonlyArray<Op> = [],
): unknown => {
  const effect = Effect.flatMap(
    cached,
    (root) => replay(root, ops) as Effect.Effect<unknown, unknown, unknown>,
  );
  return new Proxy(function () {}, {
    get(_, prop) {
      if (Reflect.has(effect, prop)) {
        return Reflect.get(effect, prop);
      }
      return chain(cached, [...ops, { kind: "get", prop }]);
    },
    has(target, prop) {
      return Reflect.has(target, prop) || Reflect.has(effect, prop);
    },
    apply(_, __, args) {
      return chain(cached, [...ops, { kind: "call", args }]);
    },
  });
};
