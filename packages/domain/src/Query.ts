import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import type * as Aggregate from "./Aggregate.ts";
import type { Data, Fields } from "./Event.ts";
import * as Middleware from "./Middleware.ts";
import type * as Projection from "./Projection.ts";
import type * as Rejection from "./Rejection.ts";

/**
 * A query's handler: one read of the projection's store. It may read what
 * the query's middleware provides (the caller), and the runtime it runs in
 * (`RuntimeContext`), as a database binding does. Resolve the store itself
 * while building it, in `toLayer`.
 */
export type Handler<
  I,
  O,
  Rejects extends ReadonlyArray<Rejection.Any>,
  Ms extends Middleware.List,
> = (
  input: I,
) => Effect.Effect<O, Aggregate.Inst<Rejects[number]>, Middleware.Provides<Ms> | RuntimeContext>;

/** A query's implementation, as its Layer provides it. @internal */
export interface Implementation {
  readonly handle: (input: never) => Effect.Effect<unknown, unknown, unknown>;
}

/** The write a read waits for: a command's `stream` and `version`. */
export const AtLeast = Schema.Struct({ stream: Schema.String, version: Schema.Number });

/**
 * Structural constraint satisfied by every query class.
 */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "Query";
  readonly queryName: string;
  /** The projection whose store it reads. */
  readonly projection: Projection.Any;
  readonly input: Schema.Top;
  readonly output: Schema.Top;
  readonly rejects: ReadonlyArray<Rejection.Any>;
  readonly middleware: Middleware.List;
  readonly rpc: Rpc.Any;
}

/** What a query takes. */
export type InputOf<Q extends Any> = Q["input"]["Type"];
/** What a query returns. */
export type OutputOf<Q extends Any> = Q["output"]["Type"];
/** The requirement identifier of a query's implementation. */
export type Identifier<Q extends Any> = Q extends Context.Key<infer I, unknown> ? I : never;

/**
 * Type-level identity of a query's implementation in an Effect's requirements.
 */
export interface QueryKey<Name extends string> {
  readonly "~alchemy/Domain/Query": Name;
}

/** The wire payload of a query: its input, and the write to wait for. */
export type PayloadFields<F extends Fields> = {
  readonly input: Schema.Struct<F>;
  readonly atLeast: Schema.optional<typeof AtLeast>;
};

/** The Effect RPC definition of a query. */
export type QueryRpc<
  Name extends string,
  F extends Fields,
  Out extends Schema.Top,
  Rejects extends ReadonlyArray<Rejection.Any>,
> = Rpc.Rpc<
  Name,
  Schema.Struct<PayloadFields<F>>,
  Out,
  Rejects extends readonly [] ? typeof Schema.Never : Schema.Union<Rejects>
>;

/**
 * The class type returned by {@link make}.
 */
export interface QueryClass<
  Name extends string,
  P extends Projection.Any,
  F extends Fields,
  Out extends Schema.Top,
  Rejects extends ReadonlyArray<Rejection.Any>,
  Ms extends Middleware.List,
  R extends Rpc.Any,
> extends Context.ServiceClass<QueryKey<Name>, string, Implementation> {
  readonly kind: "Query";
  readonly queryName: Name;
  /** The projection whose store it reads. */
  readonly projection: P;
  /** The query's input, as a `Schema.Struct`. */
  readonly input: Schema.Struct<F>;
  readonly output: Out;
  readonly rejects: Rejects;
  /** The middleware that guards the query when an Api exposes it, in order. */
  readonly middleware: Ms;
  /** The query as an Effect RPC, for exposing it in an Api. */
  readonly rpc: R;
  /**
   * Implement the query. The construction Effect runs once, resolving your
   * store; the handler then reads it for each call.
   */
  toLayer<E, R2>(
    build: Effect.Effect<Handler<Data<F>, Out["Type"], Rejects, Ms>, E, R2>,
  ): Layer.Layer<QueryKey<Name>, E, R2>;
}

/**
 * A typed read of a projection's store, exposed through an Api like a
 * command or a view. A projection writes to a store you own (a table, a
 * search index); a query is how a client asks that store a question: a
 * search, a count, a report. It names its input, its output, the rejections
 * it may return and the middleware that guards it. Its Layer holds how it
 * reads the store.
 *
 * Your store is eventually consistent with the model. A caller that has just
 * sent a command passes its receipt as `atLeast`, and the query waits until
 * the projection has handled that write first.
 *
 * ### Declaring a query
 * **Example:** Search an account's ledger
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Schema from "effect/Schema";
 * import { AccountId } from "./Account.ts";
 * import { Ledger } from "./Ledger.ts";
 * import { LedgerRow } from "./LedgerStore.ts";
 *
 * export class LedgerSearch extends Domain.Query("LedgerSearch", {
 *   projection: Ledger,
 *   input: { accountId: AccountId, kind: Schema.optional(Schema.String) },
 *   output: Schema.Array(LedgerRow),
 * }) {}
 * ```
 *
 * ### Implementing it as a Layer
 * **Example:** Read the projection's store
 * ```typescript
 * export const LedgerSearchLive = LedgerSearch.toLayer(
 *   Effect.gen(function* () {
 *     const store = yield* LedgerStore;
 *     return ({ accountId, kind }) => store.search(accountId, kind);
 *   }),
 * );
 * ```
 *
 * ### Guarding it with middleware
 * `middleware` runs in order before the handler. What it provides, such as
 * the current actor, is what the handler may read.
 *
 * **Example:** Only the owner may search
 * ```typescript
 * export class MyLedger extends Domain.Query("MyLedger", {
 *   projection: Ledger,
 *   input: { accountId: AccountId },
 *   output: Schema.Array(LedgerRow),
 *   middleware: [Session],
 *   rejects: [NotOwner],
 * }) {}
 *
 * export const MyLedgerLive = MyLedger.toLayer(
 *   Effect.gen(function* () {
 *     const store = yield* LedgerStore;
 *     return Effect.fn(function* ({ accountId }) {
 *       const actor = yield* CurrentActor;
 *       if (!(yield* owns(actor, accountId))) return yield* new NotOwner();
 *       return yield* store.search(accountId);
 *     });
 *   }),
 * );
 * ```
 *
 * ### Calling it, and reading your own write
 * **Example:** Wait for the projection, then read
 * ```typescript
 * const bank = yield* CustomerApi.client;
 * const receipt = yield* bank.DepositMoney({ target: accountId, amount: 100 });
 * const rows = yield* bank.LedgerSearch({ accountId }, { atLeast: receipt });
 * ```
 *
 * @primitive
 */
export const make = <
  const Name extends string,
  P extends Projection.Any,
  Out extends Schema.Top,
  const F extends Fields = {},
  const Ms extends Middleware.List = readonly [],
  const Rejects extends ReadonlyArray<Rejection.Any> = readonly [],
>(
  name: Name,
  options: {
    /** The projection whose store it reads. `atLeast` waits for it. */
    readonly projection: P;
    /** The query's fields. */
    readonly input?: F;
    /** What it returns: a list, a page, a count, a report. */
    readonly output: Out;
    /**
     * Middleware that guards the query when an Api exposes it, in order.
     * What it provides is what the handler may read.
     */
    readonly middleware?: Ms;
    /** The rejections the handler may return; they reach the client typed. */
    readonly rejects?: Rejects;
  },
): QueryClass<
  Name,
  P,
  F,
  Out,
  Rejects,
  Ms,
  Middleware.Apply<QueryRpc<Name, F, Out, Rejects>, Ms>
> => {
  const rejects = options.rejects ?? [];
  const input = Schema.Struct(options.input ?? ({} as F));
  const rpc = Rpc.make(name, {
    payload: { input, atLeast: Schema.optional(AtLeast) },
    success: options.output,
    error: rejects.length === 0 ? Schema.Never : Schema.Union(rejects),
  });
  const Tag = Context.Service<QueryKey<Name>, Implementation>()(`alchemy/Domain/Query/${name}`);
  return class extends Tag {
    static readonly kind = "Query" as const;
    static readonly queryName: Name = name;
    static readonly projection = options.projection;
    static readonly input = input;
    static readonly output = options.output;
    static readonly rejects = rejects;
    static readonly middleware = options.middleware ?? [];
    static readonly rpc = Middleware.apply(rpc, options.middleware ?? []);
    static toLayer<E, R>(
      build: Effect.Effect<(input: never) => Effect.Effect<unknown, unknown, unknown>, E, R>,
    ) {
      return Layer.effect(
        Tag,
        Effect.map(build, (handle): Implementation => ({ handle })),
      );
    }
  } as unknown as QueryClass<
    Name,
    P,
    F,
    Out,
    Rejects,
    Ms,
    Middleware.Apply<QueryRpc<Name, F, Out, Rejects>, Ms>
  >;
};
