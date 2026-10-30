import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import type * as Aggregate from "./Aggregate.ts";
import type { Data, Fields } from "./Event.ts";
import * as Middleware from "./Middleware.ts";
import type * as Projection from "./Projection.ts";
import type * as Rejection from "./Rejection.ts";
import type * as Saga from "./Saga.ts";
import type * as DomainStream from "./Stream.ts";
import * as Telemetry from "./Telemetry.ts";
import * as View from "./View.ts";

/** A write to read at least: a command's `stream` and `version`, as its receipt carries them. */
export interface AtLeast {
  readonly stream: string;
  readonly version: number;
}

/** What `validate` sees besides the input. */
export interface Request {
  /** The write the client asked to read at least, if any. Pass it to a view's `query`. */
  readonly atLeast: AtLeast | undefined;
}

/** The page a paged query's handler is asked for. */
export interface PageRequest {
  /** The cursor of the previous page, or `undefined` for the first. */
  readonly after: string | undefined;
  /** How many rows to return at most, already clamped to the query's `take.max`. */
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

/** What `validate` and `visible` may read besides what the middleware provides: the model's members. */
export type Member =
  | Aggregate.Key<string>
  | View.ViewKey<string>
  | DomainStream.StreamKey<string>
  | Saga.SagaKey<string>
  | Projection.ProgressKey<string>;

/** The result of a query with a `row` (a page) or a `success` schema. */
export type ResultType<Row, S> = Row extends Schema.Top
  ? Page<Row["Type"]>
  : S extends Schema.Top
    ? S["Type"]
    : void;

/** What a query's handler receives besides the input: the page, for a paged query. */
export type PageOf<Row> = Row extends Schema.Top ? PageRequest : undefined;

type RowType<Row> = Row extends Schema.Top ? Row["Type"] : never;

/**
 * A query's handler: one run, for one request. Resolve your store while
 * building it, in `toLayer`; the handler may only need what the query's
 * middleware provides (to scope the store by the caller) and the runtime it
 * runs in (`RuntimeContext`), as a database binding does.
 */
export type Handler<I, Result, E, Ctx, Page> = (
  input: I,
  page: Page,
) => Effect.Effect<Result, E, Ctx | RuntimeContext>;

/** A query's implementation, as its Layer provides it. @internal */
export interface Implementation {
  readonly handle: (
    input: unknown,
    page: PageRequest | undefined,
  ) => Effect.Effect<unknown, unknown>;
}

/** A query's declaration, widened. @internal */
export interface AnyDefinition {
  readonly input?: Fields;
  readonly row?: Schema.Top;
  readonly success?: Schema.Top;
  readonly from?: ReadonlyArray<Projection.Any>;
  readonly middleware?: Middleware.List;
  readonly rejects?: ReadonlyArray<Rejection.Any>;
  readonly take?: Take;
  readonly attributes?: Telemetry.Attributes<any>;
  readonly validate?: (input: never, request: Request) => Effect.Effect<void, unknown, unknown>;
  readonly visible?: (row: never, input: never) => Effect.Effect<boolean, unknown, unknown>;
}

/**
 * Structural constraint satisfied by every query class.
 */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "Query";
  readonly queryName: string;
  readonly definition: AnyDefinition;
  readonly middleware: Middleware.List;
  readonly rpc: Rpc.Any;
  /** Type-level only: the decoded input. */
  readonly "~input": unknown;
  /** Type-level only: the decoded result. */
  readonly "~result": unknown;
  /** Type-level only: what `validate` and `visible` read from the model. */
  readonly "~needs": unknown;
}

/** The requirement identifier of a query class. */
export type Identifier<Q extends Any> = Q extends Context.Key<infer I, unknown> ? I : never;
/** The decoded input of a query class. */
export type InputOf<Q extends Any> = Q["~input"];
/** The decoded result of a query class. */
export type ResultOf<Q extends Any> = Q["~result"];
/** The model members a query's `validate` and `visible` read. */
export type NeedsOf<Q extends Any> = Q extends Any ? Q["~needs"] : never;

/**
 * What running a query can fail with, besides its middleware's errors: its
 * rejections, and `ConsistencyTimeout` when it reads from projections.
 */
export type FailureOf<Q extends Any> =
  | Aggregate.InstanceOf<NonNullable<Q["definition"]["rejects"]>[number]>
  | (NonNullable<Q["definition"]["from"]> extends readonly [] ? never : View.ConsistencyTimeout);

/**
 * Type-level identity of a query's implementation in an Effect's requirements.
 */
export interface QueryKey<Name extends string> {
  readonly "~alchemy/Domain/Query": Name;
}

/**
 * The pure declaration of a query: its message, and how it is authorized.
 */
export interface Definition<
  F extends Fields,
  Row extends Schema.Top | undefined,
  S extends Schema.Top | undefined,
  From extends ReadonlyArray<Projection.Any>,
  Ms extends Middleware.List,
  Rejects extends ReadonlyArray<Rejection.Any>,
  RV,
  RS,
> {
  /** The query's fields. Filters, sort orders and scopes are fields too. */
  readonly input?: F;
  /** A paged query: the schema of one row. Its result is `{ entries, cursor }`. */
  readonly row?: Row;
  /** A single-result query: the schema of its result. Exclusive with `row`. */
  readonly success?: S;
  /** The projections whose stores it reads. A read `atLeast` a write waits on each. */
  readonly from?: From;
  /**
   * Middleware that guards the query when an Api exposes it, in order. What
   * it provides is what `validate`, `visible` and the handler may read.
   */
  readonly middleware?: Ms;
  /** The rejections the query may fail with; they reach the client typed. */
  readonly rejects?: Rejects;
  /** Page size limits of a paged query. */
  readonly take?: Take;
  /**
   * Span attributes to record for the query's input. Nothing from the input
   * is recorded unless you return it here, and a `Redacted` value is
   * recorded as `<redacted>`.
   */
  readonly attributes?: Telemetry.Attributes<Data<F>>;
  /**
   * Judge the request, before the store is read: may the caller (what
   * `middleware` provides) ask this? It may read the model's views,
   * aggregates and streams. Without it, anyone who reaches the Api may ask.
   */
  readonly validate?: (
    input: Data<F>,
    request: Request,
  ) => Effect.Effect<void, Aggregate.InstanceOf<Rejects[number]>, RV>;
  /**
   * Judge each row of a paged result: rows it refuses are dropped, never
   * rejected. The handler should scope its store by the caller; this is the
   * guarantee that no other row gets out. Keep it cheap: it runs per row.
   */
  readonly visible?: (row: RowType<Row>, input: Data<F>) => Effect.Effect<boolean, never, RS>;
}

/**
 * A question a client asks across keys, answered from a store you own: the
 * table, index or warehouse a {@link Projection} writes. Where a view is one
 * key's read model, a query is a message, like a command: it declares its
 * input, its result, the middleware that guards it, the rejections it may
 * return, and who may ask (`validate`) and see each row (`visible`). Its
 * Layer reads the store. List it in the model's `queries`, and in an Api to
 * give clients a typed method.
 *
 * ### Declaring a query
 * **Example:** An account's ledger, a page at a time
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Effect from "effect/Effect";
 * import * as Option from "effect/Option";
 * import * as Schema from "effect/Schema";
 * import { Account, AccountId } from "./Account.ts";
 * import { AccountSummary } from "./AccountSummary.ts";
 * import { CurrentActor } from "./CurrentActor.ts";
 * import { Ledger } from "./Ledger.ts";
 * import { NotOwner } from "./NotOwner.ts";
 * import { Session } from "./Session.ts";
 *
 * export const LedgerEntry = Schema.Struct({ id: Schema.String, kind: Schema.String, amount: Schema.Int });
 *
 * export class AccountLedger extends Domain.Query("AccountLedger", {
 *   input: { account: AccountId },
 *   row: LedgerEntry,
 *   from: [Ledger],
 *   middleware: [Session],
 *   rejects: [NotOwner],
 *   validate: Effect.fn(function* ({ account }) {
 *     const actor = yield* CurrentActor;
 *     const summary = yield* (yield* AccountSummary).query(Account.ref(account)).pipe(Effect.orDie);
 *     const owner = Option.getOrNull(summary)?.customerId;
 *     if (owner && owner !== actor.customerId) return yield* new NotOwner();
 *   }),
 * }) {}
 * ```
 *
 * ### Implementing it
 * The construction Effect runs once and resolves the store. The handler gets
 * the input and, for a paged query, the page asked for; it returns the rows
 * and the cursor of the next page (`null` on the last).
 *
 * **Example:** Reading the projection's store
 * ```typescript
 * export const AccountLedgerLive = AccountLedger.toLayer(
 *   Effect.gen(function* () {
 *     const store = yield* LedgerStore;
 *     return ({ account }, page) => store.forAccount(account, page);
 *   }),
 * );
 * ```
 *
 * ### Asking it
 * **Example:** Reading your own write, a page at a time
 * ```typescript
 * const receipt = yield* bank.DepositMoney(accountId, { amount: 100 });
 * const page = yield* bank.AccountLedger({ account: accountId }, { atLeast: receipt, take: 20 });
 * if (page.cursor) yield* bank.AccountLedger({ account: accountId }, { after: page.cursor });
 * ```
 *
 * @primitive
 */
export const make = <
  const Name extends string,
  const F extends Fields = {},
  Row extends Schema.Top | undefined = undefined,
  S extends Schema.Top | undefined = undefined,
  const From extends ReadonlyArray<Projection.Any> = readonly [],
  const Ms extends Middleware.List = readonly [],
  const Rejects extends ReadonlyArray<Rejection.Any> = readonly [],
  RV extends Middleware.Provides<Ms> | Member = never,
  RS extends Middleware.Provides<Ms> | Member = never,
>(
  name: Name,
  definition: Definition<F, Row, S, From, Ms, Rejects, RV, RS>,
): QueryClass<
  Name,
  Definition<F, Row, S, From, Ms, Rejects, RV, RS>,
  Data<F>,
  ResultType<Row, S>,
  PageOf<Row>,
  Aggregate.InstanceOf<Rejects[number]>,
  Ms,
  Exclude<RV | RS, Middleware.Provides<Ms>>
> => {
  if (definition.row && definition.success) {
    throw new Error(
      `Query '${name}' declares both \`row\` and \`success\`; it is paged or it isn't`,
    );
  }
  if (definition.visible && !definition.row) {
    throw new Error(`Query '${name}' declares \`visible\` without \`row\`: only rows are judged`);
  }
  const rejects = definition.rejects ?? [];
  const errors: ReadonlyArray<Schema.Top> = [
    ...rejects,
    ...((definition.from ?? []).length > 0 ? [View.ConsistencyTimeout] : []),
  ];
  const middleware = definition.middleware ?? [];
  const rpc = Rpc.make(name, {
    payload: {
      input: Schema.Struct(definition.input ?? {}),
      atLeast: Schema.optional(Schema.Struct({ stream: Schema.String, version: Schema.Number })),
      ...(definition.row
        ? { after: Schema.optional(Schema.String), take: Schema.optional(Schema.Number) }
        : {}),
    },
    success: definition.row
      ? Schema.Struct({
          entries: Schema.Array(definition.row),
          cursor: Schema.NullOr(Schema.String),
        })
      : (definition.success ?? Schema.Void),
    error: errors.length === 0 ? Schema.Never : Schema.Union(errors),
  });
  const Tag = Context.Service<QueryKey<Name>, Implementation>()(`alchemy/Domain/Query/${name}`);
  return class extends Tag {
    static readonly kind = "Query" as const;
    static readonly queryName: Name = name;
    static readonly definition = definition;
    static readonly middleware = middleware;
    static readonly rpc = Middleware.apply(rpc, middleware);
    static readonly attributes = definition.attributes;
    static toLayer<E, R>(build: Effect.Effect<Implementation["handle"], E, R>) {
      return Layer.effect(
        Tag,
        Effect.map(build, (handle): Implementation => ({ handle })),
      );
    }
  } as unknown as QueryClass<
    Name,
    Definition<F, Row, S, From, Ms, Rejects, RV, RS>,
    Data<F>,
    ResultType<Row, S>,
    PageOf<Row>,
    Aggregate.InstanceOf<Rejects[number]>,
    Ms,
    Exclude<RV | RS, Middleware.Provides<Ms>>
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
  Needs,
> extends Context.ServiceClass<QueryKey<Name>, string, Implementation> {
  readonly kind: "Query";
  readonly queryName: Name;
  readonly definition: Def;
  /** The middleware that guards the query when an Api exposes it, in order. */
  readonly middleware: Ms;
  /** The query as an Effect RPC, for exposing it in an Api. */
  readonly rpc: Rpc.Any;
  /** Span attributes the query adds for its input, if it declares any. */
  readonly attributes: Telemetry.Attributes<I> | undefined;
  readonly "~input": I;
  readonly "~result": Result;
  readonly "~needs": Needs;
  /**
   * Implement the query. The construction Effect runs once, resolving your
   * store; the handler may only need what the middleware provides.
   */
  toLayer<E, R>(
    build: Effect.Effect<Handler<I, Result, Rejected, Middleware.Provides<Ms>, Page>, E, R>,
  ): Layer.Layer<QueryKey<Name>, E, R>;
}

/** How a client asks a query: the page, and the write to read at least. @internal */
export interface RunOptions {
  readonly after?: string;
  readonly take?: number;
  readonly atLeast?: AtLeast;
}

/** A hosted query: `validate`, the `atLeast` wait, the handler, then `visible`. @internal */
export interface Host {
  readonly run: (input: unknown, options: RunOptions) => Effect.Effect<unknown, unknown>;
}

/**
 * Host a query: run it with the model's members available to `validate` and
 * `visible`, traced as `Domain.query <Name>` and counted by outcome.
 *
 * @internal
 */
export const host = (
  query: Any,
  implementation: Implementation,
  model: Context.Context<unknown>,
  progress: (projection: Projection.Any) => Projection.Progress,
): Host => {
  const def = query.definition;
  const name = query.queryName;
  const max = Math.max(1, Math.floor(def.take?.max ?? 500));
  const fallback = Math.min(max, Math.max(1, Math.floor(def.take?.default ?? 50)));
  const validate = def.validate as
    | ((input: unknown, request: Request) => Effect.Effect<void, unknown>)
    | undefined;
  const visible = def.visible as
    | ((row: unknown, input: unknown) => Effect.Effect<boolean>)
    | undefined;
  return {
    run: (input, { after, take, atLeast }) =>
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan(Telemetry.attributesOf(query, input));
        // Judge the request first: a refused caller never waits on a projection.
        if (validate) yield* validate(input, { atLeast });
        if (atLeast) {
          for (const projection of def.from ?? []) {
            yield* progress(projection)
              .caughtUp(atLeast)
              .pipe(
                Effect.withSpan(`Domain.caughtUp ${projection.projectionName}`, {
                  attributes: {
                    "domain.stream": atLeast.stream,
                    "domain.version": atLeast.version,
                  },
                }),
              );
          }
        }
        if (!def.row) return yield* implementation.handle(input, undefined);
        const size = take === undefined ? fallback : Math.min(max, Math.max(1, Math.floor(take)));
        const page = (yield* implementation.handle(input, {
          after,
          take: size,
        })) as Page<unknown>;
        const shown = visible
          ? yield* Effect.filter(page.entries, (row) => visible(row, input))
          : page.entries;
        yield* Effect.annotateCurrentSpan({
          "domain.query.rows": shown.length,
          "domain.query.hidden": page.entries.length - shown.length,
        });
        return { entries: shown, cursor: page.cursor };
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
