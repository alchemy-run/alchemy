/**
 * A place tables live: an Iceberg namespace, a ClickHouse database, a
 * Postgres schema. A store lists its tables; its Layer binds the store's
 * infrastructure once and provides every listed table's target (writes) and
 * raw reader (reads, decoded by the table).
 *
 * @module
 */
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as DomainFilter from "../Filter.ts";
import { isJsonObject } from "../internal.ts";
import type * as Query from "../Query.ts";
import { DefinitionError, DuplicateTableName } from "./DefinitionError.ts";
import * as Metadata from "./Metadata.ts";
import { generationName, type TableSpec } from "./Spec.ts";
import type * as Table from "./Table.ts";

// ---------------------------------------------------------------- errors

/** The store holds a table this declaration cannot become without a rebuild: bump the table's `version`. */
export class SchemaDrift extends Data.TaggedError("SchemaDrift")<{
  readonly store: string;
  readonly table: string;
  readonly generation: number;
  /** What makes it breaking, e.g. `envelope.seq: Int → String`. */
  readonly breaking: ReadonlyArray<string>;
}> {
  override get message() {
    return `Store '${this.store}' holds '${this.table}' v${this.generation} in another shape (${this.breaking.join("; ")}); bump its version`;
  }
}

/** The store could not be reached, or refused for a reason that may pass. */
export class Unavailable extends Data.TaggedError("Unavailable")<{
  readonly store: string;
  readonly operation: "ensure" | "write" | "promote" | "read";
  readonly reason: string;
}> {
  override get message() {
    return `Store '${this.store}' is unavailable for ${this.operation}: ${this.reason}`;
  }
}

/**
 * The database refused a statement the store issued, for a reason running it
 * again cannot fix (a syntax error, a violated constraint): a bug in the
 * store or a table the database cannot hold. A defect, not a failure that
 * may pass.
 */
export class StatementRejected extends Data.TaggedError("StatementRejected")<{
  readonly store: string;
  readonly operation: Unavailable["operation"];
  /** The SQL client's reason, e.g. `SqlSyntaxError`. */
  readonly code: string;
  readonly detail: string;
}> {
  override get message() {
    return `Store '${this.store}' issued a statement the database refused for ${this.operation} (${this.code}): ${this.detail}`;
  }
}

/** A stored row does not decode with its table's `Row`. */
export class RowDecodeFailed extends Data.TaggedError("RowDecodeFailed")<{
  readonly table: string;
  /** The decoder's issue, which names the failing path. */
  readonly issue: string;
}> {
  override get message() {
    return `A row of '${this.table}' does not decode: ${this.issue}`;
  }
}

// ---------------------------------------------------------------- shapes

/**
 * The JSON a store receives for each row and returns on read: the table's
 * `Row` encoded once per run with `toCodecJson` (the envelope's `at` is
 * ISO 8601, an aggregate key is its id), nothing more. Stores forward it as
 * it is.
 */
export type EncodedRow = Schema.Json;

/** The fields every store reads from a row: its identity (see {@link Identity}). */
export const StoredRow = Schema.Struct({
  key: Schema.String,
  route: Schema.String.pipe(Schema.NullOr, Schema.optional),
  envelope: Schema.Struct({ stream: Schema.String, seq: Schema.Int }),
});
export type StoredRow = typeof StoredRow.Type;

/**
 * One run, as a store receives it. The store records each row with its
 * metadata (`spec.metadata`), computed as `Metadata.evaluate` computes it:
 * writing into a generation that replaces the promoted one, it carries each
 * row's `Run` values from there, matched by identity.
 */
export interface Run extends Metadata.Run {
  /** The run's rows, each the table's `Row` as JSON. */
  readonly rows: ReadonlyArray<EncodedRow>;
}

/** How one table's rows reach its store. */
export interface Target {
  /** Make the store ready for this spec. Runs before the table's first write; idempotent. */
  readonly ensure: (
    spec: TableSpec,
  ) => Effect.Effect<void, SchemaDrift | Unavailable, RuntimeContext>;
  /** Write one run. Idempotent on the identity. */
  readonly write: (spec: TableSpec, run: Run) => Effect.Effect<void, Unavailable, RuntimeContext>;
  /** Point the stable name at this spec's generation. */
  readonly promote: (spec: TableSpec) => Effect.Effect<void, Unavailable, RuntimeContext>;
}

/**
 * A row's identity in every store: the event's place in its aggregate's
 * stream, and the key (and route) it was handled for. A projection may route
 * one event to several keys, or twice to one key; each is its own row.
 */
export interface Identity {
  readonly key: string;
  readonly route?: string | null | undefined;
  readonly stream: string;
  readonly seq: number;
}

/** An identity as one string, the same in every store: what a store indexes rows on. */
export const identityKey = (identity: Identity): string =>
  JSON.stringify([identity.key, identity.route ?? null, identity.stream, identity.seq]);

/** A stored row's identity. */
export const identityOf = (row: StoredRow): Identity => ({
  key: row.key,
  route: row.route ?? undefined,
  stream: row.envelope.stream,
  seq: row.envelope.seq,
});

/**
 * What a store is asked to read: Domain's `Filter` and `OrderBy`, as a read
 * receives them over the wire (`where` encoded with `Filter.FilterJson`, a
 * date as its ISO string). A store evaluates them where the rows live (SQL
 * `WHERE`, `ORDER BY`); `Filter.matches` and `Filter.sort` are their meaning.
 */
export interface ReadRequest {
  readonly where?: DomainFilter.Filter<Schema.JsonObject> | undefined;
  /** Top-level columns, as `Filter.sort` orders them. Without it, rows come in log order. */
  readonly orderBy?: DomainFilter.OrderBy<Schema.JsonObject> | undefined;
}

/** How the rows a read selects lag: count and milliseconds from commit to store, of `_export_lag_ms`. */
export interface LagSummary {
  readonly count: number;
  /** `null` when no row has a lag. */
  readonly min: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

/** A store's reads of one table, each row the JSON it was written as plus its metadata. */
export interface RawReader {
  readonly get: (
    identity: Identity,
  ) => Effect.Effect<Option.Option<EncodedRow>, Unavailable, RuntimeContext>;
  readonly list: (
    request: ReadRequest,
    page: Query.PageRequest,
  ) => Effect.Effect<Query.Page<EncodedRow>, Unavailable, RuntimeContext>;
  readonly scan: (request: ReadRequest) => Stream.Stream<EncodedRow, Unavailable, RuntimeContext>;
  /** Summarize the lag of the rows `where` selects (`orderBy` is ignored). Quantiles are nearest-rank. */
  readonly lag: (request: ReadRequest) => Effect.Effect<LagSummary, Unavailable, RuntimeContext>;
}

/** What a store's Layer builds once: per table spec, its target and its raw reader. */
export interface Implementation {
  readonly target: (spec: TableSpec) => Target;
  readonly reader: (spec: TableSpec) => RawReader;
  /**
   * The name engines read a table under right now, for a store that cannot
   * keep a view under the stable name (an Iceberg catalog): its promoted
   * generation, or the spec's own before any promotion. Without it, the
   * stable name is a view the store keeps, and engines read it directly.
   */
  readonly stableName?:
    | ((spec: TableSpec) => Effect.Effect<string, Unavailable, RuntimeContext>)
    | undefined;
}

/** Type-level identity of a table's target in an Effect's requirements. */
export interface TargetKey<Name extends string> {
  readonly "~alchemy/Domain/Export/Target": Name;
}
/** Type-level identity of a table's raw reader in an Effect's requirements. */
export interface RawReaderKey<Name extends string> {
  readonly "~alchemy/Domain/Export/RawReader": Name;
}

/** Type-level identity of a store's built implementation in an Effect's requirements. */
export interface StoreKey<Name extends string> {
  readonly "~alchemy/Domain/Export/Store": Name;
}

/**
 * Structural constraint satisfied by every store declaration.
 */
export interface Any {
  readonly kind: "Store";
  readonly storeName: string;
  readonly tables: ReadonlyArray<Table.Any>;
  readonly Store: Context.Key<StoreKey<string>, Implementation>;
}

/**
 * A store declaration. Its `Store` service holds the built implementation,
 * as a table's `Target` holds its writes; `toLayer` binds the
 * infrastructure once, and `place` gives each listed table its target and
 * raw reader from it. The declaration holds its service rather than being
 * one: a class extending a service carries the service's self-typed
 * `Unify` symbol, which a declared interface cannot match without a cast
 * (`Projection.make` casts there); holding it needs none. `Engine` follows.
 */
export interface StoreClass<Name extends string, Tables extends ReadonlyArray<Table.Any>> {
  new (): object;
  readonly kind: "Store";
  readonly storeName: Name;
  readonly tables: Tables;
  /** The built store. Provided by `toLayer` or `memory`. */
  readonly Store: Context.Service<StoreKey<Name>, Implementation>;
  /** Bind the store's infrastructure once. Dies if two listed tables share a physical name. */
  toLayer<E, R>(
    build: Effect.Effect<Implementation, E, R>,
  ): Layer.Layer<StoreKey<Name>, E, Exclude<R, Scope.Scope>>;
  /** The store in memory, for stories and tests. */
  memory(): Layer.Layer<StoreKey<Name>>;
  /** One listed table's target and raw reader, from the built store. */
  place<TargetId, RawReaderId>(table: {
    readonly tableName: Tables[number]["tableName"];
    readonly spec: TableSpec;
    readonly Target: Context.Key<TargetId, Target>;
    readonly RawReader: Context.Key<RawReaderId, RawReader>;
  }): Layer.Layer<TargetId | RawReaderId, never, StoreKey<Name>>;
}

// ---------------------------------------------------------------- the factory

const duplicateNames = (
  store: string,
  tables: ReadonlyArray<Table.Any>,
): ReadonlyArray<DuplicateTableName> => {
  const byName = new Map<string, ReadonlyArray<string>>();
  for (const table of tables)
    byName.set(table.spec.name, [...(byName.get(table.spec.name) ?? []), table.tableName]);
  return [...byName].flatMap(([physical, names]) =>
    names.length > 1 ? [new DuplicateTableName({ store, physical, tables: names })] : [],
  );
};

/**
 * Declare a store: the tables it holds. `toLayer` binds its infrastructure
 * once (an implementation such as `Export.Sql.store` or
 * `Export.Iceberg.store`); `place` gives each listed table its target and
 * raw reader from it. A table is placed in one store; two tables of one
 * store cannot share a physical name (the Layer dies with
 * `DuplicateTableName`).
 *
 * ### Declaring a store
 * **Example:** A Postgres schema holding two tables
 * ```typescript
 * import * as Export from "@alchemy.run/domain/Export";
 * import { PgClient } from "@effect/sql-pg";
 * import * as Layer from "effect/Layer";
 *
 * export class Warehouse extends Export.Store("Warehouse", { tables: [Facts, Labor] }) {}
 *
 * export const WarehouseLive = Warehouse.toLayer(Export.Sql.store()).pipe(
 *   Layer.provide(PgClient.layer({ url })),
 * );
 *
 * export const Tables = Layer.mergeAll(Warehouse.place(Facts), Warehouse.place(Labor)).pipe(
 *   Layer.provide(WarehouseLive),
 * );
 * ```
 *
 * ### Exporting to a lake
 * **Example:** An Iceberg REST catalog, written through DuckDB
 * ```typescript
 * import * as Export from "@alchemy.run/domain/Export";
 * import * as Iceberg from "@alchemy.run/domain/Export/Iceberg";
 * import * as FetchHttpClient from "effect/http/FetchHttpClient";
 * import * as Layer from "effect/Layer";
 *
 * export class Lake extends Export.Store("Lake", { tables: [Facts, Labor] }) {}
 *
 * export const LakeLive = Lake.toLayer(Iceberg.store({ namespace: "facts" })).pipe(
 *   Layer.provide(
 *     Iceberg.layer({
 *       catalog: new Iceberg.Rest({ uri: "http://lakekeeper:8181/catalog", warehouse: "warehouse" }),
 *     }),
 *   ),
 *   Layer.provide(FetchHttpClient.layer),
 * );
 * ```
 *
 * ### Testing with a store in memory
 * **Example:** The same tables, held in memory for a story or a test
 * ```typescript
 * const Tables = Layer.mergeAll(Lake.place(Facts), Lake.place(Labor)).pipe(
 *   Layer.provide(Lake.memory()),
 * );
 * ```
 *
 * @primitive
 */
export const make = <const Name extends string, const Tables extends ReadonlyArray<Table.Any>>(
  name: Name,
  definition: { readonly tables: Tables },
): StoreClass<Name, Tables> => {
  const Tag = Context.Service<StoreKey<Name>, Implementation>()(
    `alchemy/Domain/Export/Store/${name}`,
  );
  const duplicates = duplicateNames(name, definition.tables);
  const toLayer = <E, R>(
    build: Effect.Effect<Implementation, E, R>,
  ): Layer.Layer<StoreKey<Name>, E, Exclude<R, Scope.Scope>> =>
    Layer.effect(
      Tag,
      duplicates[0] === undefined
        ? build
        : Effect.die(new DefinitionError({ reason: duplicates[0] })),
    );
  return class {
    static readonly Store = Tag;
    static readonly kind = "Store" as const;
    static readonly storeName = name;
    static readonly tables = definition.tables;
    static toLayer<E, R>(build: Effect.Effect<Implementation, E, R>) {
      return toLayer(build);
    }
    static memory() {
      return toLayer(Effect.sync(memory));
    }
    static place<TargetId, RawReaderId>(table: {
      readonly tableName: Tables[number]["tableName"];
      readonly spec: TableSpec;
      readonly Target: Context.Key<TargetId, Target>;
      readonly RawReader: Context.Key<RawReaderId, RawReader>;
    }) {
      // A store declaration's service is itself the Effect that yields the built implementation.
      const store = Tag;
      return Layer.merge(
        Layer.effect(
          table.Target,
          Effect.map(store, (built) => built.target(table.spec)),
        ),
        Layer.effect(
          table.RawReader,
          Effect.map(store, (built) => built.reader(table.spec)),
        ),
      );
    }
  };
};

/** The store services a list of stores provides, by type. */
export type KeysOf<Stores extends ReadonlyArray<Any>> = Stores[number]["Store"]["Identifier"];

/**
 * Every listed store with its built implementation. Requires exactly the
 * listed stores' services, so a Layer built on it names them.
 */
export const implementationsOf = <Stores extends ReadonlyArray<Any>>(
  stores: Stores,
): Effect.Effect<
  ReadonlyArray<{ readonly store: Stores[number]; readonly implementation: Implementation }>,
  never,
  KeysOf<Stores>
> =>
  // A cast: each element yields its own store's service; `Effect.forEach` widens a tuple's per-element requirements to the constraint (`StoreKey<string>`), and TypeScript has no cast-free fold of a tuple into the union `KeysOf` names.
  Effect.forEach(stores, (store) =>
    Effect.map(store.Store, (implementation) => ({ store, implementation })),
  ) as Effect.Effect<
    ReadonlyArray<{ readonly store: Stores[number]; readonly implementation: Implementation }>,
    never,
    KeysOf<Stores>
  >;

// ---------------------------------------------------------------- memory

const indexOf = (row: StoredRow) => identityKey(identityOf(row));

/** One stored row: the JSON as written with its metadata, and its identity. */
interface Entry {
  readonly json: Schema.JsonObject;
  readonly identity: string;
}

const readStored = Schema.decodeUnknownEffect(StoredRow);

/** Nearest-rank quantiles of the lag column, the meaning every store's summary keeps. */
export const summarizeLag = (rows: ReadonlyArray<Schema.JsonObject>): LagSummary => {
  const lags = rows.flatMap((row) => {
    const lag = row[Metadata.lagColumn];
    return typeof lag === "number" ? [lag] : [];
  });
  lags.sort((a, b) => a - b);
  const rank = (q: number) => lags[Math.max(Math.ceil(q * lags.length) - 1, 0)] ?? null;
  return {
    count: lags.length,
    min: lags[0] ?? null,
    p50: rank(0.5),
    p95: rank(0.95),
    p99: rank(0.99),
    max: lags[lags.length - 1] ?? null,
  };
};

/**
 * A store in memory: one map per generation, idempotent on the identity,
 * with promotion. Rows keep their insertion order, which is the log order
 * and the cursor. Reads evaluate the request with `Filter.matches` and
 * `Filter.sort`, and metadata with `Metadata.evaluate`: the meaning every
 * store must keep.
 */
export const memory = (): Implementation => {
  const generations = new Map<string, Map<string, Entry>>();
  const fingerprints = new Map<string, string>();
  const promoted = new Map<string, string>();
  const generation = (name: string) => {
    const existing = generations.get(name);
    if (existing !== undefined) return existing;
    const created = new Map<string, Entry>();
    generations.set(name, created);
    return created;
  };
  /** What readers see: the promoted generation, or the spec's own before any promotion. */
  const visible = (spec: TableSpec) => generation(promoted.get(spec.name) ?? generationName(spec));
  const rowsOf = (spec: TableSpec, request: ReadRequest) =>
    DomainFilter.sort(
      [...visible(spec).values()]
        .map((entry) => entry.json)
        .filter((json) => DomainFilter.matches(request.where, json)),
      request.orderBy,
    );
  /** The generation a write into `spec`'s replaces, if any: the promoted one, when it is another. */
  const replaced = (spec: TableSpec) => {
    const source = promoted.get(spec.name);
    return source === undefined || source === generationName(spec)
      ? undefined
      : generations.get(source);
  };
  return {
    target: () => ({
      ensure: (spec) =>
        Effect.suspend(() => {
          const name = generationName(spec);
          const held = fingerprints.get(name);
          if (held !== undefined && held !== spec.fingerprint) {
            return Effect.fail(
              new SchemaDrift({
                store: "memory",
                table: spec.table,
                generation: spec.generation,
                breaking: ["the table's columns or metadata"],
              }),
            );
          }
          fingerprints.set(name, spec.fingerprint);
          generation(name);
          return Effect.void;
        }),
      write: (spec, run) =>
        Effect.forEach(run.rows, (json) =>
          isJsonObject(json)
            ? readStored(json).pipe(Effect.map((row) => ({ json, identity: indexOf(row) })))
            : Effect.die(
                new RowDecodeFailed({ table: spec.table, issue: "a row is not a JSON object" }),
              ),
        ).pipe(
          Effect.map((rows) => {
            const table = generation(generationName(spec));
            const source = replaced(spec);
            for (const { json, identity } of rows) {
              if (table.has(identity)) continue;
              const metadata = Metadata.evaluate(
                spec.metadata,
                json,
                run,
                source?.get(identity)?.json,
              );
              table.set(identity, { json: Object.assign({}, json, metadata), identity });
            }
          }),
          // A row the memory store cannot index is a bug in the table, not a store failure.
          Effect.orDie,
        ),
      promote: (spec) => Effect.sync(() => void promoted.set(spec.name, generationName(spec))),
    }),
    reader: (spec) => ({
      get: (identity) =>
        Effect.sync(() =>
          Option.map(
            Option.fromNullishOr(visible(spec).get(identityKey(identity))),
            (entry) => entry.json,
          ),
        ),
      list: (request, { after, take }) =>
        Effect.sync(() => {
          const rows = rowsOf(spec, request);
          const start = after === undefined ? 0 : Number(after);
          return {
            entries: rows.slice(start, start + take),
            cursor: start + take < rows.length ? String(start + take) : null,
          };
        }),
      scan: (request) => Stream.suspend(() => Stream.fromIterable(rowsOf(spec, request))),
      lag: (request) => Effect.sync(() => summarizeLag(rowsOf(spec, { where: request.where }))),
    }),
  };
};
