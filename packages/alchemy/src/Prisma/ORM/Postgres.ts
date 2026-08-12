// `@prisma/orm-postgres` (and pg underneath) are optional peers — value
// imports are deferred to first use so `alchemy/Prisma` resolves without
// them installed. This module is deliberately NOT exported from the barrel;
// import it as `alchemy/Prisma/ORM/Postgres`.
import type { SqlStorage } from "@prisma/orm-family-sql/contract/types";
import type { Contract } from "@prisma/orm-postgres/contract/types";
import type {
  PostgresClient,
  PostgresOptionsBase,
} from "@prisma/orm-postgres/runtime";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { makeExecutionMemo } from "../../Runtime/ExecutionMemo.ts";

/** Any emitted prisma-next contract (the `Contract` type from `contract.d.ts`). */
export type AnyPostgresContract = Contract<SqlStorage>;

/**
 * A prisma-next runtime failure, carrying the structured `code` prisma-next
 * attaches to its errors (e.g. `ORM.INCLUDE_INVALID`) when one is present.
 */
export class PrismaError extends Data.TaggedError("Prisma.PrismaError")<{
  code?: string | undefined;
  message: string;
  cause: unknown;
}> {}

const errorCode = (cause: unknown): string | undefined => {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
};

const wrapError = (cause: unknown): PrismaError =>
  new PrismaError({
    code: errorCode(cause),
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

export interface PostgresConfig extends PostgresOptionsBase {
  /**
   * The emitted contract IR — import it from the `contract.json` written by
   * {@link Contract} (or `prisma-next contract emit`):
   *
   * ```typescript
   * import contractJson from "./prisma/contract.json" with { type: "json" };
   * ```
   */
  readonly contractJson: unknown;
}

export interface PostgresDatabase<
  C extends AnyPostgresContract,
  E = never,
  R = never,
> {
  /**
   * The prisma-next client for the current execution. Prefer {@link use};
   * reach for this when handing the raw client to promise-land code.
   */
  readonly client: Effect.Effect<PostgresClient<C>, E, R>;
  /**
   * Run a query (or several) against the execution's client, converting the
   * promise-based prisma-next API into an Effect with a typed error channel:
   *
   * ```typescript
   * const user = yield* db.use((c) => c.orm.public.User.where({ email }).first());
   * ```
   */
  readonly use: <A>(
    f: (client: PostgresClient<C>) => PromiseLike<A>,
  ) => Effect.Effect<A, PrismaError | E, R>;
}

/**
 * Open a Prisma ORM v8 (prisma-next) Postgres client from a connection URL.
 *
 * The client is built at most once per execution — a Worker
 * `fetch`/`queue`/`scheduled` event, a Durable Object call, a Workflow run,
 * or a Lambda invocation — and memoized on the execution's `Scope` (via
 * {@link makeExecutionMemo}), with `close()` registered as a scope finalizer
 * so the underlying `pg` pool never outlives its event. That per-execution
 * lifecycle is what makes the full prisma-next client (`orm`, `sql`, `raw`,
 * `transaction`) safe on workerd, where sockets are pinned to the creating
 * request's IoContext. Construction itself does no I/O (prisma-next connects
 * lazily on the first query), so deploy/plan-time evaluations never touch
 * the database.
 *
 * prisma-next's API is promise-based, so queries run through
 * {@link PostgresDatabase.use} rather than being yielded directly. The
 * factory is curried (`Postgres<Contract>()(source, config)`, like
 * `Cloudflare.Worker<T>()`) so the contract type is explicit while the
 * source's error/requirement channels still infer:
 *
 * ```typescript
 * import * as PrismaPostgres from "alchemy/Prisma/ORM/Postgres";
 * import type { Contract } from "./prisma/contract.d.ts";
 * import contractJson from "./prisma/contract.json" with { type: "json" };
 *
 * const db = yield* PrismaPostgres.Postgres<Contract>()(
 *   Cloudflare.Hyperdrive.Connect(hyperdrive).connectionString,
 *   { contractJson },
 * );
 *
 * fetch: Effect.gen(function* () {
 *   const users = yield* db.use((c) => c.orm.public.User.all());
 *   const posts = yield* db.use((c) =>
 *     c.transaction(async (tx) => tx.orm.public.Post.all()),
 *   );
 * });
 * ```
 *
 * Yielding the connection string is likewise deferred into the memo, so
 * sources that require a deployed environment (Hyperdrive bindings, secrets)
 * resolve only inside a real execution.
 *
 * @binding
 * @category ORM
 */
export const Postgres =
  <C extends AnyPostgresContract>() =>
  <E = never, R = never>(
    connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>,
    config: PostgresConfig,
  ): Effect.Effect<PostgresDatabase<C, E, R>> =>
    Effect.map(
      makeExecutionMemo(
        Effect.gen(function* () {
          const { contractJson, ...options } = config;
          const runtime = yield* Effect.promise(
            () => import("@prisma/orm-postgres/runtime"),
          );
          const url = Redacted.value(yield* connectionString);
          const client = runtime.default<C>({ contractJson, url, ...options });
          yield* Effect.addFinalizer(() =>
            Effect.tryPromise(() => client.close()).pipe(Effect.ignore),
          );
          return client;
        }),
      ),
      (client): PostgresDatabase<C, E, R> => ({
        client,
        use: (f) =>
          Effect.flatMap(client, (c) =>
            Effect.tryPromise({
              try: () => Promise.resolve(f(c)),
              catch: wrapError,
            }),
          ),
      }),
    );
