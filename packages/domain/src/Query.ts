import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import type * as Aggregate from "./Aggregate.ts";
import type { Annotations } from "./Annotations.ts";
import type { Data, Fields } from "./Event.ts";
import { inputSchema } from "./internal.ts";
import * as Middleware from "./Middleware.ts";
import type * as Projection from "./Projection.ts";
import type * as Rejection from "./Rejection.ts";
import type * as DomainStream from "./Stream.ts";
import * as Telemetry from "./Telemetry.ts";
import * as View from "./View.ts";

/** A write to read at least: a command's `stream` and `version`, as its receipt carries them. */
export interface AtLeast {
  readonly stream: string;
  readonly version: number;
}

/** A receipt on the wire. */
const Receipt = Schema.Struct({ stream: Schema.String, version: Schema.Number });

/** One receipt, or one per command a client sent before it asks. */
export type AtLeastInput = AtLeast | ReadonlyArray<AtLeast>;

/** The receipts a client passed as `atLeast`, as a list. @internal */
export const receiptsOf = (atLeast: AtLeastInput | undefined): ReadonlyArray<AtLeast> =>
  atLeast === undefined ? [] : Array.isArray(atLeast) ? atLeast : [atLeast as AtLeast];

/** The page a paged query's handler is asked for. */
export interface PageRequest {
  /** The cursor of the previous page, or `undefined` for the first. */
  readonly after: string | undefined;
  /** How many entries to return at most, already clamped to the Layer's `take.max`. */
  readonly take: number;
}

/** A page of a paged query's rows. */
export interface Page<Row> {
  readonly entries: ReadonlyArray<Row>;
  /** Pass as `after` for the next page; `null` on the last. The store chooses its encoding. */
  readonly cursor: string | null;
}

/** Page size limits of a paged query. */
export interface Take {
  /** Rows per page when the client doesn't say. @default 50 */
  readonly default?: number;
  /** The most rows a client may ask for. @default 500 */
  readonly max?: number;
}

/** A query's result: its `success`, or a page of them when it is `paged`. */
export type ResultType<P extends boolean, S> = S extends Schema.Top
  ? P extends true
    ? Page<S["Type"]>
    : S["Type"]
  : void;

/** What a query's handler receives besides the input: the page, for a paged query. */
export type PageOf<P extends boolean> = P extends true ? PageRequest : undefined;

/**
 * A query's handler: one run, for one request. Resolve your store and the
 * model members it reads (a view's client, say) while building it, in
 * `toLayer`; the handler may only need what the query's middleware provides
 * (who is asking) and the runtime it runs in (`RuntimeContext`), as a
 * database binding does. It checks who may ask by failing with one of the
 * query's rejections, and returns only the rows the caller may see.
 */
export type Handler<I, Result, E, Ctx, Page> = (
  input: I,
  page: Page,
) => Effect.Effect<Result, E, Ctx | RuntimeContext>;

/** How a query's Layer runs it: tuning that changes no caller's types. */
export interface LayerOptions {
  /** Page size limits of a paged query. @default { default: 50, max: 500 } */
  readonly take?: Take;
}

/** A query's implementation, as its Layer provides it. @internal */
export interface Implementation {
  readonly handle: (
    input: unknown,
    page: PageRequest | undefined,
  ) => Effect.Effect<unknown, unknown>;
  readonly options: LayerOptions;
}

/** A query's declaration, widened. @internal */
export interface AnyDefinition {
  readonly input?: Fields;
  readonly success?: Schema.Top;
  readonly paged?: boolean;
  readonly waitsFor?: ReadonlyArray<Waitable>;
  readonly middleware?: Middleware.List;
  readonly rejects?: ReadonlyArray<Rejection.Any>;
}

/**
 * Structural constraint satisfied by every query class.
 */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "Query";
  readonly annotations: Annotations;
  readonly queryName: string;
  readonly definition: AnyDefinition;
  readonly middleware: Middleware.List;
  readonly rpc: Rpc.Any;
  /** Type-level only: the decoded input. */
  readonly "~input": unknown;
  /** Type-level only: the decoded result. */
  readonly "~result": unknown;
}

/** The requirement identifier of a query class. */
export type Identifier<Q extends Any> = Q extends Context.Key<infer I, unknown> ? I : never;
/** The decoded input of a query class. */
export type InputOf<Q extends Any> = Q["~input"];
/** The decoded result of a query class. */
export type ResultOf<Q extends Any> = Q["~result"];

/**
 * What running a query can fail with, besides its middleware's errors: its
 * rejections, and `ConsistencyTimeout` when it has `waitsFor`.
 */
export type FailureOf<Q extends Any> =
  | Aggregate.InstanceOf<NonNullable<Q["definition"]["rejects"]>[number]>
  | (NonNullable<Q["definition"]["waitsFor"]> extends readonly []
      ? never
      : View.ConsistencyTimeout);

/**
 * Type-level identity of a query's implementation in an Effect's requirements.
 */
export interface QueryKey<Name extends string> {
  readonly "~alchemy/Domain/Query": Name;
}

/**
 * The declaration of a query: its message, the middleware that guards it,
 * and the rejections it may fail with. Its handler, on its Layer, does the
 * rest.
 */
export interface Definition<
  F extends Fields,
  P extends boolean,
  S extends Schema.Top | undefined,
  From extends ReadonlyArray<Waitable>,
  Ms extends Middleware.List,
  Rejects extends ReadonlyArray<Rejection.Any>,
> {
  /** The query's fields. Filters, sort orders and scopes are fields too. */
  readonly input?: F;
  /**
   * The schema of the result, or with `paged`, of one entry of a page.
   * Without it, the query answers nothing (`void`).
   */
  readonly success?: S;
  /**
   * Answer a page at a time: the result is `{ entries, cursor }`, where each
   * entry is a `success`, and the client pages with `after` and `take`.
   * @default false
   */
  readonly paged?: P;
  /**
   * The reads to wait on when a caller passes a command's receipt as
   * `atLeast`, before the handler runs: projections (whose store it reads),
   * views and streams. The caller passes only the receipt: the keys to wait
   * on come from that command's own events, routed through each read's
   * `key`/`keyOf`, so they may be keyed differently. A view waits for an
   * aggregate it reads directly; a stream, for the projections that write
   * it. An aggregate is never listed: the handler reads its latest commit
   * with `get`. Reads not listed here are not covered.
   */
  readonly waitsFor?: From;
  /**
   * Middleware that guards the query when an Api exposes it, in order. What
   * it provides is what the handler may read: who is asking.
   */
  readonly middleware?: Ms;
  /**
   * The rejections the query may fail with; they reach the client typed.
   * The handler fails with one to refuse a caller.
   */
  readonly rejects?: Rejects;
}

/**
 * A question a client asks across keys, answered from a store you own: the
 * table, index or warehouse a {@link Projection} writes. Where a view is one
 * key's read model, a query is a message, like a command: it declares its
 * input, its result, the middleware that guards it, and the rejections it
 * may return. Its Layer is one handler: it checks who may ask, then reads
 * the store, scoped to what the caller may see. List it in the model's
 * `queries`, and in an Api to give clients a typed method.
 *
 * ### Declaring a query
 * **Example:** An account's ledger, a page at a time
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Schema from "effect/Schema";
 * import { AccountId } from "./Account.ts";
 * import { Ledger } from "./Ledger.ts";
 * import { NotOwner } from "./NotOwner.ts";
 * import { Session } from "./Session.ts";
 *
 * export const LedgerEntry = Schema.Struct({ id: Schema.String, kind: Schema.String, amount: Schema.Int });
 *
 * export class AccountLedger extends Domain.Query("AccountLedger", {
 *   input: { account: AccountId },
 *   success: LedgerEntry,
 *   paged: true,
 *   waitsFor: [Ledger],
 *   middleware: [Session],
 *   rejects: [NotOwner],
 * }) {}
 * ```
 *
 * ### Implementing it
 * The construction Effect runs once and resolves the store and any model
 * member the handler reads. The handler gets the input and, for a paged
 * query, the page asked for. It refuses a caller by failing with one of the
 * query's rejections, and returns the entries and the cursor of the next
 * page (`null` on the last, never a short page).
 *
 * **Example:** Checking the caller, then reading the projection's store
 * ```typescript
 * export const AccountLedgerLive = AccountLedger.toLayer(
 *   Effect.gen(function* () {
 *     const store = yield* LedgerStore;
 *     const summaries = yield* AccountSummary;
 *     return Effect.fn(function* ({ account }, page) {
 *       const actor = yield* CurrentActor;
 *       const summary = yield* summaries.get(Account.ref(account)).pipe(Effect.orDie);
 *       const owner = Option.getOrNull(summary)?.customerId;
 *       if (owner && owner !== actor.customerId) return yield* new NotOwner();
 *       return yield* store.forAccount(account, page);
 *     });
 *   }),
 * );
 * ```
 *
 * ### Asking it
 * Most calls are plain reads and get what the store holds now.
 *
 * **Example:** A page at a time
 * ```typescript
 * const page = yield* bank.AccountLedger({ account: accountId }, { take: 20 });
 * if (page.cursor) yield* bank.AccountLedger({ account: accountId }, { after: page.cursor });
 * ```
 *
 * **Example:** Every entry, as a Stream
 * ```typescript
 * const entries = yield* bank.AccountLedger.entries({ account: accountId }).pipe(Stream.runCollect);
 * ```
 *
 * Right after its own command, a client passes the command's receipt as
 * `atLeast`. The query finds the keys to wait on in that command's events,
 * waits until every read in `waitsFor` has handled them, then runs the handler.
 * The caller passes receipts, never projections or keys: one, or one per
 * command when it wrote to several aggregate instances.
 *
 * **Example:** Reading your own write
 * ```typescript
 * const receipt = yield* bank.DepositMoney(accountId, { amount: 100 });
 * const page = yield* bank.AccountLedger({ account: accountId }, { atLeast: receipt });
 * ```
 *
 * ### Annotating queries
 * The last argument is its annotations: data for what is built on the
 * model, read back as `X.annotations`. Add your own keys by augmenting
 * `Domain.Annotations`.
 *
 * An Api's MCP tools, CLI help and OpenAPI document show its `description`.
 *
 * **Example:** A description
 * ```typescript
 * export class AccountLedger extends Domain.Query(
 *   "AccountLedger",
 *   { input: { account: AccountId }, success: LedgerRow, paged: true },
 *   { description: "One account's ledger, a page at a time." },
 * ) {}
 * ```
 *
 * @primitive
 */
export const make = <
  const Name extends string,
  const F extends Fields = {},
  const P extends boolean = false,
  S extends Schema.Top | undefined = undefined,
  const From extends ReadonlyArray<Waitable> = readonly [],
  const Ms extends Middleware.List = readonly [],
  const Rejects extends ReadonlyArray<Rejection.Any> = readonly [],
>(
  name: Name,
  definition: Definition<F, P, S, From, Ms, Rejects>,
  annotations: Annotations = {},
): QueryClass<
  Name,
  Definition<F, P, S, From, Ms, Rejects>,
  Data<F>,
  ResultType<P, S>,
  PageOf<P>,
  Aggregate.InstanceOf<Rejects[number]>,
  Ms
> => {
  const rejects = definition.rejects ?? [];
  const errors: ReadonlyArray<Schema.Top> = [
    ...rejects,
    ...((definition.waitsFor ?? []).length > 0 ? [View.ConsistencyTimeout] : []),
  ];
  const middleware = definition.middleware ?? [];
  const rpc = Rpc.make(name, {
    payload: {
      input: inputSchema(definition.input),
      atLeast: Schema.optional(Schema.Union([Receipt, Schema.Array(Receipt)])),
      ...(definition.paged
        ? { after: Schema.optional(Schema.String), take: Schema.optional(Schema.Number) }
        : {}),
    },
    success: definition.paged
      ? Schema.Struct({
          entries: Schema.Array(definition.success ?? Schema.Void),
          cursor: Schema.NullOr(Schema.String),
        })
      : (definition.success ?? Schema.Void),
    error: errors.length === 0 ? Schema.Never : Schema.Union(errors),
  });
  const Tag = Context.Service<QueryKey<Name>, Implementation>()(`alchemy/Domain/Query/${name}`);
  return class extends Tag {
    static readonly kind = "Query" as const;
    static readonly annotations: Annotations = annotations;
    static readonly queryName: Name = name;
    static readonly definition = definition;
    static readonly middleware = middleware;
    static readonly rpc = Middleware.apply(rpc, middleware);
    static toLayer<E, R>(
      build: Effect.Effect<Implementation["handle"], E, R>,
      options: LayerOptions = {},
    ) {
      return Layer.effect(
        Tag,
        Effect.map(build, (handle): Implementation => ({ handle, options })),
      );
    }
  } as unknown as QueryClass<
    Name,
    Definition<F, P, S, From, Ms, Rejects>,
    Data<F>,
    ResultType<P, S>,
    PageOf<P>,
    Aggregate.InstanceOf<Rejects[number]>,
    Ms
  >;
};

/**
 * The class type returned by {@link make}.
 */
export interface QueryClass<
  Name extends string,
  Def extends AnyDefinition,
  I,
  Result,
  Page,
  Rejected,
  Ms extends Middleware.List,
> extends Context.ServiceClass<QueryKey<Name>, string, Implementation> {
  readonly kind: "Query";
  readonly annotations: Annotations;
  readonly queryName: Name;
  readonly definition: Def;
  /** The middleware that guards the query when an Api exposes it, in order. */
  readonly middleware: Ms;
  /** The query as an Effect RPC, for exposing it in an Api. */
  readonly rpc: Rpc.Any;
  readonly "~input": I;
  readonly "~result": Result;
  /**
   * Implement the query. The construction Effect runs once, resolving your
   * store and the model members the handler reads; the handler may only need
   * what the middleware provides. The options tune how it runs: page size
   * limits.
   */
  toLayer<E, R>(
    build: Effect.Effect<Handler<I, Result, Rejected, Middleware.Provides<Ms>, Page>, E, R>,
    options?: LayerOptions,
  ): Layer.Layer<QueryKey<Name>, E, R>;
}

/** How a client asks a query: the page, and the writes to read at least. @internal */
export interface RunOptions {
  readonly after?: string;
  readonly take?: number;
  readonly atLeast?: AtLeastInput;
}

/** Wait until a read has handled a command's events. @internal */
export type CaughtUp = (
  receipt: AtLeast,
  options?: { readonly timeout?: Duration.Input },
) => Effect.Effect<void, View.ConsistencyTimeout>;

/** What a query may wait on: a projection, a view, or a stream. */
export type Waitable = Projection.Any | View.Any | DomainStream.Any;

const nameOfWaitable = (read: Waitable): string =>
  read.kind === "Projection"
    ? read.projectionName
    : read.kind === "View"
      ? read.viewName
      : read.streamName;

/** A hosted query: the `atLeast` wait, then the handler. @internal */
export interface Host {
  readonly run: (input: unknown, options: RunOptions) => Effect.Effect<unknown, unknown>;
}

/**
 * Host a query: wait for the caller's writes, run its handler, traced as
 * `Domain.query <Name>` and counted by outcome.
 *
 * @internal
 */
export const host = (
  query: Any,
  implementation: Implementation,
  model: Context.Context<unknown>,
  caughtUpOf: (read: Waitable) => CaughtUp,
): Host => {
  const def = query.definition;
  const name = query.queryName;
  const take = implementation.options.take;
  const max = Math.max(1, Math.floor(take?.max ?? 500));
  const fallback = Math.min(max, Math.max(1, Math.floor(take?.default ?? 50)));
  return {
    run: (input, { after, take, atLeast }) =>
      Effect.gen(function* () {
        const receipts = receiptsOf(atLeast);
        // Every receipt, through every projection: each command's events name its own keys.
        for (const receipt of receipts) {
          for (const read of def.waitsFor ?? []) {
            yield* caughtUpOf(read)(receipt).pipe(
              Effect.withSpan(`Domain.caughtUp ${nameOfWaitable(read)}`, {
                attributes: {
                  "domain.stream": receipt.stream,
                  "domain.version": receipt.version,
                },
              }),
            );
          }
        }
        if (!def.paged) return yield* implementation.handle(input, undefined);
        const size = take === undefined ? fallback : Math.min(max, Math.max(1, Math.floor(take)));
        const page = (yield* implementation.handle(input, {
          after,
          take: size,
        })) as Page<unknown>;
        yield* Effect.annotateCurrentSpan("domain.query.rows", page.entries.length);
        return page;
      }).pipe(
        // The model's members fill in under the request's own services.
        Effect.updateContext((context: Context.Context<never>) =>
          Context.merge(model as Context.Context<never>, context),
        ),
        Effect.onExit((exit) => {
          const outcome = Exit.isSuccess(exit)
            ? "ok"
            : Option.match(Cause.findErrorOption(exit.cause), {
                onNone: () => "defect",
                onSome: Telemetry.outcomeOf,
              });
          return Effect.andThen(
            Effect.annotateCurrentSpan("domain.outcome", outcome),
            Telemetry.record(Telemetry.queries, {
              "domain.query": name,
              "domain.outcome": outcome,
            }),
          );
        }),
        Effect.withSpan(`Domain.query ${name}`, { attributes: { "domain.query": name } }),
      ) as Effect.Effect<unknown, unknown>,
  };
};
