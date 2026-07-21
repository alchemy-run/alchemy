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
 * The type of a {@link proxyChain} handle.
 *
 * Yielding a chain runs the cached effect first, so the cached effect's
 * error and requirement channels are part of every leaf the chain can
 * produce. When both channels are `never` the handle is exactly `T`;
 * otherwise every `Effect` reachable through the chain — property reads
 * and call returns, at any depth — is widened with the cached `E` and `R`
 * so nothing is erased from the types.
 */
export type ProxyChain<T, E = never, R = never> = [E | R] extends [never]
  ? T
  : Widen<T, E, R>;

type Widen<T, E, R> =
  T extends Effect.Effect<infer A, infer XE, infer XR>
    ? Effect.Effect<A, XE | E, XR | R> & {
        [K in keyof T as K extends keyof Effect.Effect<never>
          ? never
          : K]: Widen<T[K], E, R>;
      }
    : T extends (...args: infer Args) => infer Ret
      ? ((...args: Args) => Widen<Ret, E, R>) & {
          [K in keyof T]: Widen<T[K], E, R>;
        }
      : T extends object
        ? { [K in keyof T]: Widen<T[K], E, R> }
        : T;

/**
 * Wrap a cached `Effect<T, E, R>` in a chainable Proxy so callers can use
 * the returned value as if it were `T` itself — every property read and
 * call records a step, and the chain is replayed against the resolved
 * value when it's finally yielded as an Effect.
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
 * The cached effect's error and requirement channels survive: because a
 * yielded chain evaluates the cached effect before replaying, its `E` and
 * `R` are threaded onto every `Effect` the chain can produce (see
 * {@link ProxyChain}). For example:
 *
 * ```typescript
 * // PgClient.make: Effect<PgClient, SqlError, Scope | Reactivity>
 * const sql = proxyChain(PgClient.make({ url }));
 *
 * fetch: Effect.gen(function* () {
 *   // Effect<readonly Row[], SqlError, Scope | Reactivity> — the
 *   // deferred connect's failure and requirements are not erased.
 *   const rows = yield* sql`select * from users`;
 * });
 * ```
 *
 * Widening rebuilds method signatures structurally, which collapses
 * per-call generic inference on the widened surface. When full inference
 * fidelity matters (e.g. drizzle's `select()`), discharge the channels
 * first — hand `proxyChain` an `Effect<T>` — and the handle is exactly
 * `T`.
 */
export const proxyChain = <T, E = never, R = never>(
  cached: Effect.Effect<T, E, R>,
): ProxyChain<T, E, R> => chain(cached) as ProxyChain<T, E, R>;

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
