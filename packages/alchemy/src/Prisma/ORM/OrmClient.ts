// Effect-native facade over prisma-next's `orm` lane.
//
// Runtime: a path-replaying Proxy. Chainable calls and property accesses are
// recorded, and only a *terminal* call (first/all/create/...) produces an
// Effect — which replays the whole chain against the per-execution client's
// live Collection inside `Effect.tryPromise`. Replay-per-evaluation makes
// every query lazy and re-runnable (`Effect.retry` re-issues it), exactly
// like an effect-native builder, without forking prisma-next's Collection.
//
// Types: hand-authored rather than mapped from `Collection`. Mapped types
// erase method-level generics (`include`'s relation-name literal, `select`'s
// field tuple) and collapse overloads, silently widening row inference — so
// the surface below re-declares the supported subset faithfully from
// prisma-next's *exported* type utilities. Methods not yet re-typed
// (groupBy, combine, variant, cursor, distinctOn) still work through
// `db.use(...)`.
//
// This module is internal scaffolding: NOT exported from the ORM index.
// Consumers reach it through `alchemy/Prisma/ORM/Postgres`.
import type { SqlStorage } from "@prisma/orm-family-sql/contract/types";
import type { Contract } from "@prisma/orm-postgres/contract/types";
import type {
  AggregateBuilder,
  AggregateResult,
  AggregateSpec,
  CreateInput,
  DefaultModelRow,
  ModelAccessor,
  RelatedModelName,
  RelationNames,
  RelationsOf,
  ShorthandWhereFilter,
  UniqueConstraintCriterion,
} from "@prisma/orm-postgres/orm-client";
import * as Effect from "effect/Effect";
import { type ClientError, wrapPrismaError } from "./Errors.ts";

type AnyContract = Contract<SqlStorage>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type NamespacesOf<C> = C extends { domain: { namespaces: infer N } }
  ? N
  : never;

type ModelsOf<C, Ns> =
  NamespacesOf<C> extends infer N
    ? Ns extends keyof N
      ? N[Ns] extends { models: infer M }
        ? M
        : never
      : never
    : never;

/**
 * A `where` filter: either the shorthand object form or a callback over the
 * typed model accessor (`(u) => u.email.eq(email)`). The callback's return
 * is prisma-next's opaque predicate expression.
 */
export type WhereFilter<
  C extends AnyContract,
  M extends string,
  Ns extends string,
> =
  | ShorthandWhereFilter<C, M, Ns>
  | ((model: ModelAccessor<C, M, Ns>) => unknown);

type OrderBySelector<
  C extends AnyContract,
  M extends string,
  Ns extends string,
> = (model: ModelAccessor<C, M, Ns>) => unknown;

type RelationOf<
  C extends AnyContract,
  M extends string,
  Ns extends string,
  Rel extends string,
> =
  RelationsOf<C, M, Ns> extends infer Rels
    ? Rel extends keyof Rels
      ? Rels[Rel]
      : never
    : never;

type RelationTargetNs<Relation, Fallback extends string> = Relation extends {
  readonly to: { readonly namespace: infer N extends string };
}
  ? N
  : Fallback;

/**
 * The row shape an included relation contributes: an array for to-many
 * cardinalities, `Row | null` for to-one (widened — FK-nullability precision
 * is not reproduced here).
 */
type IncludedValue<
  C extends AnyContract,
  M extends string,
  Ns extends string,
  Rel extends string,
> =
  RelationOf<C, M, Ns, Rel> extends infer Relation
    ? Relation extends { readonly cardinality: infer Card }
      ? Card extends "1:N" | "N:M" | "M:N"
        ? Array<
            Simplify<
              DefaultModelRow<
                C,
                RelatedModelName<C, M, Rel, Ns> & string,
                RelationTargetNs<Relation, Ns>
              >
            >
          >
        : Simplify<
            DefaultModelRow<
              C,
              RelatedModelName<C, M, Rel, Ns> & string,
              RelationTargetNs<Relation, Ns>
            >
          > | null
      : never
    : never;

/**
 * The Effect-native view of one prisma-next model collection. Chainables
 * mirror `Collection`'s row/filter typing; terminals return Effects with
 * {@link ClientError} in the error channel. `HasWhere` reproduces
 * prisma-next's compile-time gate: `update`/`delete` require a prior
 * `.where(...)`.
 */
export interface EffectCollection<
  C extends AnyContract,
  Ns extends string,
  M extends string,
  Row,
  HasWhere extends boolean = false,
  E = never,
  R = never,
> {
  where(
    filter: WhereFilter<C, M, Ns>,
  ): EffectCollection<C, Ns, M, Row, true, E, R>;

  include<Rel extends RelationNames<C, M, Ns>>(
    relation: Rel,
  ): EffectCollection<
    C,
    Ns,
    M,
    Simplify<Row & { [K in Rel]: IncludedValue<C, M, Ns, K> }>,
    HasWhere,
    E,
    R
  >;

  select<
    Fields extends readonly [
      keyof DefaultModelRow<C, M, Ns> & string,
      ...(keyof DefaultModelRow<C, M, Ns> & string)[],
    ],
  >(
    ...fields: Fields
  ): EffectCollection<
    C,
    Ns,
    M,
    Simplify<
      Pick<DefaultModelRow<C, M, Ns>, Fields[number]> &
        Omit<Row, keyof DefaultModelRow<C, M, Ns>>
    >,
    HasWhere,
    E,
    R
  >;

  orderBy(
    selection:
      | OrderBySelector<C, M, Ns>
      | ReadonlyArray<OrderBySelector<C, M, Ns>>,
  ): EffectCollection<C, Ns, M, Row, HasWhere, E, R>;

  distinct(): EffectCollection<C, Ns, M, Row, HasWhere, E, R>;
  take(n: number): EffectCollection<C, Ns, M, Row, HasWhere, E, R>;
  skip(n: number): EffectCollection<C, Ns, M, Row, HasWhere, E, R>;

  // ── read terminals ────────────────────────────────────────────────

  all(): Effect.Effect<Row[], ClientError | E, R>;
  first(
    filter?: WhereFilter<C, M, Ns>,
  ): Effect.Effect<Row | null, ClientError | E, R>;
  aggregate<Spec extends AggregateSpec>(
    fn: (aggregate: AggregateBuilder<C, M, Ns>) => Spec,
  ): Effect.Effect<AggregateResult<Spec>, ClientError | E, R>;

  // ── write terminals ───────────────────────────────────────────────

  create(data: CreateInput<C, M, Ns>): Effect.Effect<Row, ClientError | E, R>;
  createAll(
    data: readonly CreateInput<C, M, Ns>[],
  ): Effect.Effect<Row[], ClientError | E, R>;
  createAndCount(
    data: readonly CreateInput<C, M, Ns>[],
  ): Effect.Effect<number, ClientError | E, R>;
  upsert(input: {
    create: CreateInput<C, M, Ns>;
    update: Partial<DefaultModelRow<C, M, Ns>>;
    conflictOn?: UniqueConstraintCriterion<C, M>;
  }): Effect.Effect<Row, ClientError | E, R>;

  update(
    data: HasWhere extends true ? Partial<CreateInput<C, M, Ns>> : never,
  ): Effect.Effect<Row | null, ClientError | E, R>;
  updateAll(
    data: HasWhere extends true ? Partial<DefaultModelRow<C, M, Ns>> : never,
  ): Effect.Effect<Row[], ClientError | E, R>;
  updateAndCount(
    data: HasWhere extends true ? Partial<DefaultModelRow<C, M, Ns>> : never,
  ): Effect.Effect<number, ClientError | E, R>;

  delete(
    this: HasWhere extends true
      ? EffectCollection<C, Ns, M, Row, HasWhere, E, R>
      : never,
  ): Effect.Effect<Row | null, ClientError | E, R>;
  deleteAll(
    this: HasWhere extends true
      ? EffectCollection<C, Ns, M, Row, HasWhere, E, R>
      : never,
  ): Effect.Effect<Row[], ClientError | E, R>;
  deleteAndCount(
    this: HasWhere extends true
      ? EffectCollection<C, Ns, M, Row, HasWhere, E, R>
      : never,
  ): Effect.Effect<number, ClientError | E, R>;
}

/** `db.orm.<namespace>.<Model>` — every model as an {@link EffectCollection}. */
export type EffectOrm<C extends AnyContract, E = never, R = never> = {
  readonly [Ns in keyof NamespacesOf<C> & string]: {
    readonly [M in keyof ModelsOf<C, Ns> & string]: EffectCollection<
      C,
      Ns,
      M,
      Simplify<DefaultModelRow<C, M, Ns>>,
      false,
      E,
      R
    >;
  };
};

// ── runtime ─────────────────────────────────────────────────────────

/**
 * Collection methods whose call executes the query. Everything else is
 * either a chainable (returns a new Collection) or a property access
 * (namespace/model lookup) — both recorded and replayed lazily.
 */
const TERMINALS = new Set([
  "all",
  "first",
  "aggregate",
  "create",
  "createAll",
  "createAndCount",
  "upsert",
  "update",
  "updateAll",
  "updateAndCount",
  "delete",
  "deleteAll",
  "deleteAndCount",
]);

interface PathStep {
  readonly prop: string;
  readonly args?: readonly unknown[];
}

const replayPath = (base: unknown, path: readonly PathStep[]): unknown =>
  path.reduce<any>(
    (current, step) =>
      step.args === undefined
        ? current[step.prop]
        : current[step.prop](...step.args),
    base,
  );

const node = (
  root: Effect.Effect<unknown, any, any>,
  path: readonly PathStep[],
): any =>
  new Proxy(function () {}, {
    get: (_target, prop) => {
      // Not thenable: a bare chain must never be awaited (only terminals
      // produce Effects), and a `then` node would hang a stray `await`.
      if (typeof prop !== "string" || prop === "then") return undefined;
      return node(root, [...path, { prop }]);
    },
    apply: (_target, _this, args: unknown[]) => {
      const last = path[path.length - 1]!;
      const called = [...path.slice(0, -1), { prop: last.prop, args }];
      if (TERMINALS.has(last.prop)) {
        return Effect.flatMap(root, (base) =>
          Effect.tryPromise({
            // Terminals return a PromiseLike (AsyncIterableResult for the
            // streaming ones — awaiting it buffers to Row[]).
            try: () => Promise.resolve(replayPath(base, called) as any),
            catch: wrapPrismaError,
          }),
        );
      }
      return node(root, called);
    },
  });

/**
 * Build the `db.orm` facade over a lazily-resolved root (`client.orm` for
 * the per-execution client, or a tx-scoped `orm(...)` inside a
 * transaction). Chains are recorded and replayed per evaluation.
 */
export const makeOrmProxy = <C extends AnyContract, E, R>(
  root: Effect.Effect<unknown, E, R>,
): EffectOrm<C, E, R> => node(root, []) as EffectOrm<C, E, R>;
