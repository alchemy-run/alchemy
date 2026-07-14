import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { proxyChainWith } from "../Util/proxy-chain.ts";

/** A failed Prisma operation. The original Prisma error is in `cause`. */
export class PrismaError extends Data.TaggedError("PrismaError")<{
  message: string;
  cause: unknown;
}> {}

/** The subset of a generated `PrismaClient` the wrapper needs. */
export interface PrismaClientLike {
  $disconnect(): Promise<void>;
}

/**
 * A generated `PrismaClient` type with every promise-returning operation
 * lifted into an `Effect`. `yield* prisma.user.findMany()` produces
 * `Effect<User[], PrismaError, RuntimeContext>`; yielding an intermediate
 * node (e.g. `yield* prisma`) resolves the underlying value itself, which is
 * how to reach the raw promise-based client for `$transaction` callbacks.
 */
export type EffectPrismaClient<C> = EffectifyValue<C>;

type EffectifyValue<T> =
  T extends PromiseLike<infer U>
    ? Effect.Effect<U, PrismaError, RuntimeContext>
    : T extends (...args: infer A) => infer R
      ? (...args: A) => EffectifyValue<R>
      : T extends object
        ? { [K in keyof T]: EffectifyValue<T[K]> } & Effect.Effect<
            T,
            PrismaError,
            RuntimeContext
          >
        : Effect.Effect<T, PrismaError, RuntimeContext>;

/**
 * Per-execution client memos, keyed on the execution's `Scope` object. Every
 * bridge (Worker event, Durable Object call, Workflow run, Lambda invoke)
 * provides a fresh `Scope` per execution, so an entry lives exactly as long
 * as its execution and is garbage-collected with the scope object.
 */
const caches = new WeakMap<
  Scope.Scope,
  Map<symbol, Effect.Effect<any, any, any>>
>();

/**
 * Open a Prisma client from a per-execution `make` Effect that constructs
 * the generated `PrismaClient` with a driver adapter.
 *
 * Returns a chainable Proxy over the client (via `proxyChainWith`) — every
 * property read records a step, every call records args, and the chain is
 * replayed against the resolved client when it's finally yielded as an
 * Effect. The terminal `PrismaPromise` is wrapped in `Effect.tryPromise`, so
 * callers never touch a raw promise:
 *
 * ```typescript
 * const prisma = yield* Prisma.client(Effect.sync(() =>
 *   new PrismaClient({ adapter: new PrismaPg("postgres://…") }),
 * ));
 *
 * fetch: Effect.gen(function* () {
 *   const users = yield* prisma.user.findMany();
 * });
 * ```
 *
 * The `make` Effect is deferred until the first query and memoized on the
 * current execution's `Scope` (`yield* Effect.scope`), so the client — and
 * the connection pool its adapter owns — is built at most once per execution
 * (a Worker `fetch`/`queue`/`scheduled` event, a Durable Object call, a
 * Workflow run, or a Lambda invocation) and reused across every query in
 * that execution. `$disconnect` is registered as a finalizer on that same
 * scope, so the pool closes when the request / run settles — never leaking
 * I/O objects across workerd requests.
 *
 * Prefer the adapter-specific entry points, which compose this:
 * `alchemy/Prisma/Postgres` (Hyperdrive, Neon, PlanetScale Postgres — any
 * Postgres URI), `alchemy/Prisma/D1`, `alchemy/Prisma/PlanetScale`, and
 * `alchemy/Prisma/Neon`.
 *
 * @binding
 */
export const client = <C extends PrismaClientLike, E = never, R = never>(
  make: Effect.Effect<C, E, R>,
): Effect.Effect<EffectPrismaClient<C>> =>
  Effect.sync(function () {
    const symbol = Symbol();

    return proxyChainWith<EffectPrismaClient<C>, unknown>(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        let cache = caches.get(scope);
        if (cache === undefined) {
          caches.set(scope, (cache = new Map()));
        }
        let memo = cache.get(symbol);
        if (memo === undefined) {
          // `Effect.cached` only allocates the memo cell — the build runs
          // on first evaluation — so this yield is synchronous and the
          // fiber cannot be interleaved between the miss check and the
          // set: a concurrent first query joins this memo (evaluating the
          // same cached effect) instead of building a second client.
          memo = yield* Effect.cached(
            Effect.gen(function* () {
              const prisma = yield* make;
              yield* Scope.addFinalizer(
                scope,
                Effect.promise(() => prisma.$disconnect()).pipe(Effect.ignore),
              );
              return prisma;
            }),
          );
          cache.set(symbol, memo);
        }
        return yield* memo;
      }) as Effect.Effect<C>,
      (value) =>
        Predicate.hasProperty(value, "then") && Predicate.isFunction(value.then)
          ? Effect.tryPromise({
              try: () => value as PromiseLike<unknown> as Promise<unknown>,
              catch: (cause) =>
                new PrismaError({
                  message:
                    cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
            })
          : Effect.succeed(value),
    );
  });
