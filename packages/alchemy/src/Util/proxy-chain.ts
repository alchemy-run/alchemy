/** @effect-diagnostics anyUnknownInErrorContext:off */
import * as Effect from "effect/Effect";

type Op = { kind: "get"; prop: PropertyKey } | { kind: "call"; args: unknown[] };

interface ChainState {
  readonly cached: Effect.Effect<unknown, any, any>;
  readonly ops: ReadonlyArray<Op>;
}

/**
 * Every proxy produced by {@link chain} is registered here so that a chain
 * passed as an *argument* to another chain over the same `cached` effect
 * (e.g. `` sql`... ${sql.insert(row)}` `` — the nested `sql.insert(row)` is
 * itself a proxy) can be recognized and replayed against the same resolved
 * root instead of being handed to the real client as an opaque proxy.
 */
const chainStates = new WeakMap<object, ChainState>();

/**
 * Replay an op chain against a real value. `get` reads a property,
 * `call` invokes — bound to the previous receiver so `this` resolves
 * to the object the method was read from (drizzle's `select()` etc.
 * read `this._.session`, so dropping `this` would throw).
 */
const replay = (
  root: unknown,
  ops: ReadonlyArray<Op>,
  cached: Effect.Effect<unknown, any, any>,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown => {
  let cur: any = root;
  let receiver: any = root;
  for (const op of ops) {
    if (op.kind === "get") {
      receiver = cur;
      cur = cur[op.prop];
    } else {
      cur = cur.apply(receiver, replayArgs(root, op.args, cached, seen));
      receiver = cur;
    }
  }
  return cur;
};

/**
 * Resolve nested chain proxies inside a call's arguments. Only proxies over
 * the *same* `cached` effect can be replayed synchronously (the root is
 * already resolved); proxies over a different effect pass through untouched.
 * Arrays and object fields are walked, because a Drizzle `sql` chunk or
 * `eq(...)` condition stores the proxy inside an object rather than as the
 * argument itself. The original value is returned when nothing changed, so
 * identity-sensitive values (e.g. a `TemplateStringsArray` with its `raw`
 * property) are preserved.
 */
const replayArgs = (
  root: unknown,
  args: ReadonlyArray<unknown>,
  cached: Effect.Effect<unknown, any, any>,
  seen: WeakMap<object, unknown>,
): ReadonlyArray<unknown> => {
  let out: unknown[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const resolved = replayArg(root, args[i], cached, seen);
    if (resolved !== args[i]) {
      out ??= [...args];
      out[i] = resolved;
    }
  }
  return out ?? args;
};

const replayArg = (
  root: unknown,
  arg: unknown,
  cached: Effect.Effect<unknown, any, any>,
  seen: WeakMap<object, unknown>,
): unknown => {
  if (arg === null || (typeof arg !== "object" && typeof arg !== "function")) {
    return arg;
  }
  const state = chainStates.get(arg);
  if (state) {
    // A proxy over some other effect cannot be replayed against this root.
    if (state.cached !== cached) return arg;
    return replay(root, state.ops, cached, seen);
  }
  // Fragments may arrive wrapped in arrays (e.g. `sql.and([a, b])`).
  if (Array.isArray(arg)) {
    return replayArgs(root, arg, cached, seen);
  }
  // Chain proxies are functions and were handled above. Other functions stay
  // as-is: copying one would drop its call behavior.
  if (typeof arg === "function") return arg;
  return replayFields(root, arg, cached, seen);
};

/**
 * Copy an object only when a nested same-cache proxy was resolved. The copy
 * keeps the original prototype so class methods (`SQL.getSQL`, and the like)
 * still run. Accessors are copied without being invoked.
 */
const replayFields = (
  root: unknown,
  value: object,
  cached: Effect.Effect<unknown, any, any>,
  seen: WeakMap<object, unknown>,
): unknown => {
  const seenValue = seen.get(value);
  if (seenValue !== undefined) return seenValue;
  seen.set(value, value);

  const keys = Reflect.ownKeys(value);
  const fields: Array<{ key: PropertyKey; descriptor: PropertyDescriptor }> = [];
  let changed = false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) {
      fields.push({ key, descriptor });
      continue;
    }
    const next = replayArg(root, descriptor.value, cached, seen);
    if (next !== descriptor.value) changed = true;
    fields.push({
      key,
      descriptor: next === descriptor.value ? descriptor : { ...descriptor, value: next },
    });
  }
  if (!changed) return value;

  const copy: object = Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const field of fields) {
    Object.defineProperty(copy, field.key, field.descriptor);
  }
  return copy;
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
 * A chain passed as an *argument* to another chain over the same effect —
 * e.g. `` sql`INSERT INTO users ${sql.insert(row)}` ``, where `sql.insert(row)`
 * is itself a deferred proxy — is replayed against the same resolved root
 * before the outer call runs, so synchronous fragment helpers compose.
 * Object fields are walked too, so a proxy stored inside a Drizzle SQL
 * chunk (`` sql`count(${cte.id})` ``, `eq(cte.parent, id)`) resolves the same way.
 */
export const proxyChain = <T>(cached: Effect.Effect<T, any, any>): T => chain(cached) as T;

/**
 * Property reads the Effect runtime uses as *brand probes* — `symbol` keys
 * and `~effect/...` type-id strings (`~effect/Exit`, `~effect/Effect`, …).
 * The fiber's generator runner distinguishes a yielded Effect from an Exit
 * with `value[ExitTypeId] !== undefined` (effect ≥ 4.0.0-rc.113; earlier
 * releases used `in`, which the `has` trap already answers). Recording such
 * a read as a chain step would hand back a truthy proxy, so the runner
 * would treat every chain as an already-settled Exit and resume the
 * generator with `proxy.value` — another proxy — instead of running it.
 * Brand probes therefore answer `undefined` when the underlying effect
 * lacks the key; the `has` trap keeps `in`-based probes correct too.
 */
const isBrandProbe = (prop: PropertyKey): boolean =>
  typeof prop === "symbol" || (typeof prop === "string" && prop.startsWith("~effect/"));

const chain = (cached: Effect.Effect<unknown, any, any>, ops: ReadonlyArray<Op> = []): unknown => {
  const effect = Effect.flatMap(
    cached,
    (root) => replay(root, ops, cached) as Effect.Effect<unknown, unknown, unknown>,
  );
  const proxy = new Proxy(function () {}, {
    get(_, prop) {
      if (Reflect.has(effect, prop)) {
        return Reflect.get(effect, prop);
      }
      if (isBrandProbe(prop)) {
        return undefined;
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
  chainStates.set(proxy, { cached, ops });
  return proxy;
};
