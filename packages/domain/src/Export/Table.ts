/**
 * A table of a projection's events in a store you own. An `Export.Table` is
 * a `Domain.Projection`: list it in the model's `projections` and the host
 * delivers to it, backfills it and reports its progress. Its row, its
 * table spec and its handler are derived; nothing is written per table.
 *
 * Run a table's `promoter()` beside its `reader` wherever the model is
 * hosted: after a `version` bump it points the stable name at the rebuilt
 * generation once that has caught up. Without it, SQL engines keep reading
 * the old generation, while `reader` and Iceberg engines read the new one as
 * it fills.
 *
 * @module
 */
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as BigDecimal from "effect/BigDecimal";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Stream from "effect/Stream";
import { Envelope } from "../Aggregate.ts";
import type { Annotations } from "../Annotations.ts";
import type * as Event from "../Event.ts";
import { type Filter, FilterJson, type OrderBy } from "../Filter.ts";
import * as Key from "../Key.ts";
import * as Projection from "../Projection.ts";
import * as Query from "../Query.ts";
import * as Telemetry from "../Telemetry.ts";
import type * as View from "../View.ts";
import { DefinitionError, MetadataRedefined, type Reason } from "./DefinitionError.ts";
import * as Metadata from "./Metadata.ts";
import * as Sensitive from "./Sensitive.ts";
import {
  columnsOf,
  eventSpecOf,
  fingerprintOf,
  metadataOf,
  protect,
  protectEvent,
  type TableSpec,
} from "./Spec.ts";
import {
  type EncodedRow,
  type Identity,
  type LagSummary,
  type RawReader,
  type RawReaderKey,
  type ReadRequest,
  RowDecodeFailed,
  type Target,
  type TargetKey,
  type Unavailable,
} from "./Store.ts";

// ---------------------------------------------------------------- shapes

/** What a table is, independent of any store. */
export interface Options<
  M extends Metadata.Fields<M> = {},
  P extends Sensitive.Policy | undefined = undefined,
> {
  /** The physical base name; generation n is `<table>_v<n>`. */
  readonly table: string;
  /**
   * The generation. Bump it for a change the store cannot take in place: the
   * table is rebuilt from history into `<table>_v<version>`, and readers move
   * to it once the table's `promoter` sees the rebuild has caught up.
   * @default 0
   */
  readonly version?: number;
  /**
   * What happens to event fields annotated `sensitive` (see `Export.Sensitive`).
   * Required when there are any. `"encrypt"` makes the table require a `Sealer`.
   */
  readonly sensitive?: P;
  /**
   * Metadata beside the built-in `_export_ingested_at` and `_export_lag_ms`,
   * each field built with `Export.Metadata`. Changing it needs a new `version`.
   */
  readonly metadata?: M;
}

/** How a table runs: a projection's batching, and how long a transient store failure is retried inside a run. */
export interface LayerOptions {
  /**
   * The projection's batching (`Projection.Options["batch"]`). Unset, each
   * event is its own run: one store round-trip per event, and on Iceberg one
   * commit (a snapshot) per event.
   */
  readonly batch?: Projection.Options["batch"];
  /**
   * How long a write the store reports `Unavailable` is retried inside the
   * run, before the run fails and the host retries it (every 10 seconds).
   * @default "5 seconds"
   */
  readonly transient?: Duration.Input;
  /**
   * How often the promoter checks whether a new generation has caught up,
   * and retries a promotion the store reports `Unavailable`.
   * @default "5 seconds"
   */
  readonly promoteEvery?: Duration.Input;
}

/** Type-level identity of a table's decoded reader in an Effect's requirements. */
export interface ReaderKey<Name extends string> {
  readonly "~alchemy/Domain/Export/Reader": Name;
}

/**
 * An event an export can store: one whose Schema needs no services to
 * encode or decode, which every `Domain.Event` with plain fields is.
 */
export type Exportable = Event.Any & {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
};

/**
 * An aggregate key's column: the ref is stored as its id. A transformation,
 * so encoding a projection input needs no per-row mapping, and decoding a
 * stored row gives back a ref-shaped `{ id }`.
 */
export const AggregateKey = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Struct({ id: Schema.String }),
    SchemaTransformation.transform({
      decode: (id: string) => ({ id }),
      encode: (ref: { readonly id: string }) => ref.id,
    }),
  ),
);

/** An event as `"omit"` stores it: its tag, and fields that may be absent. */
export type PartialEvent<E> = E extends { readonly _tag: infer T }
  ? { readonly _tag: T } & { readonly [K in Exclude<keyof E, "_tag">]?: E[K] }
  : never;

/** The service a policy needs: a `Sealer` to encrypt. */
export type SealerOf<P> = [P] extends ["encrypt"] ? Sensitive.Sealer : never;

/**
 * The events as a table stores them: the declared events, or under
 * `"omit"` events whose fields may be absent; sealing under `"encrypt"`
 * needs a `Sealer` to encode and decode. One Codec type, so a table generic
 * over its policy still knows exactly which services its rows need.
 */
export type StoredEvent<On extends ReadonlyArray<Exportable>, P> = Schema.Codec<
  [P] extends ["omit"] ? PartialEvent<On[number]["Type"]> : On[number]["Type"],
  unknown,
  SealerOf<P>,
  SealerOf<P>
>;

/** The events as a table writes them: the declared events, encoded under the policy. */
export type WrittenEvent<On extends ReadonlyArray<Exportable>, P> = Schema.Codec<
  On[number]["Type"],
  unknown,
  SealerOf<P>,
  SealerOf<P>
>;

/**
 * A row's route: the named route of `keyOf` the input came by, or none for a
 * key reached one way. JSON has no `undefined`, so none is stored as `null`.
 */
export const Route = Schema.String.pipe(Schema.NullOr, Schema.optional);

/**
 * The row a table stores for one input: its key (an aggregate's ref is
 * stored as its id), its route, its log position, the envelope and the
 * event. A projection input carries more (`source`, `state`); encoding with
 * this Struct keeps exactly these fields.
 */
export type RowSchema<On extends ReadonlyArray<Exportable>, P = undefined> = Schema.Struct<{
  readonly key: typeof AggregateKey | typeof Schema.String;
  readonly route: typeof Route;
  readonly position: typeof Schema.Int;
  readonly envelope: typeof Envelope;
  readonly event: WrittenEvent<On, P>;
}>;

/** The fields of a read row: the key's id, position, envelope, event, declared metadata and built-in metadata. */
export type ReadFields<
  On extends ReadonlyArray<Exportable>,
  M extends Metadata.Fields<M>,
  P = undefined,
> = {
  key: typeof Schema.String;
  route: typeof Route;
  position: typeof Schema.Int;
  envelope: typeof Envelope;
  event: StoredEvent<On, P>;
} & M &
  typeof Metadata.builtIn;

// `Object.assign` types its result as the intersection of its arguments, so an
// absent `metadata` (`undefined & …` is `never`) leaves exactly the declared columns;
// a spread of `M | undefined` would drop `M` from the type.
const readFields = <On extends ReadonlyArray<Exportable>, M extends Metadata.Fields<M>, P>(
  event: StoredEvent<On, P>,
  metadata: M | undefined,
): ReadFields<On, M, P> =>
  Object.assign(
    { key: Schema.String, route: Route, position: Schema.Int, envelope: Envelope, event },
    metadata,
    Metadata.builtIn,
  );

/** A row as a reader returns it. */
export type ReadSchema<
  On extends ReadonlyArray<Exportable>,
  M extends Metadata.Fields<M>,
  P = undefined,
> = Schema.Struct<ReadFields<On, M, P>>;

/** A value a column holds whole: the walk does not flatten into it. */
type Leaf =
  | DateTime.DateTime
  | Date
  | Uint8Array
  | BigDecimal.BigDecimal
  | Option.Option<unknown>
  | ReadonlyArray<unknown>;

/**
 * Every column of a read row, by dotted path: nested structs flatten as the
 * table's spec flattens them, and the event union is one column, `event`.
 */
export type ColumnPath<T> = {
  readonly [K in keyof T & string]: K extends "event"
    ? K
    : NonNullable<T[K]> extends Leaf
      ? K
      : NonNullable<T[K]> extends object
        ? `${K}.${ColumnPath<NonNullable<T[K]>>}`
        : K;
}[keyof T & string];

/** Brands a column reference. @internal */
export const ColumnTypeId: unique symbol = Symbol.for("alchemy/Domain/Export/Column");

/** One column of a table, for an engine query: rendered as the table's name and the column's physical name. */
export interface ColumnRef<Name extends string = string> {
  readonly [ColumnTypeId]: typeof ColumnTypeId;
  readonly tableName: Name;
  readonly path: string;
}

/** Is this query value a column reference? @internal */
export const isColumn = (value: unknown): value is ColumnRef =>
  Predicate.hasProperty(value, ColumnTypeId);

/**
 * Structural constraint satisfied by every table class.
 */
export interface Any extends Projection.Any {
  readonly tableName: string;
  readonly spec: TableSpec;
  readonly Target: Context.Key<TargetKey<string>, Target>;
  readonly RawReader: Context.Key<RawReaderKey<string>, RawReader>;
}

/** Consistency for one read, as `View.Host.get` takes it. */
export interface ReadOptions {
  /** Wait until the table has handled these writes (a command's receipt), through its `Progress.caughtUp`. */
  readonly atLeast?: Query.AtLeastInput | undefined;
  readonly timeout?: Duration.Input | undefined;
}

/** A read of many rows: Domain's `Filter` and `OrderBy` over the read row, paged as a paged query is. */
export interface ListOptions<Row> extends ReadOptions {
  readonly where?: Filter<Row> | undefined;
  /** Top-level columns. Without it, rows come in log order. */
  readonly orderBy?: OrderBy<Row> | undefined;
  readonly after?: string | undefined;
  /** Rows per page: 50 when unsaid, at most 500, as a paged query's `take`. */
  readonly take?: number | undefined;
}

export type ReadError = Unavailable | RowDecodeFailed | View.ConsistencyTimeout;

/**
 * Reads of one table, shaped as Domain reads a View (`View.Host`): its
 * `history`, one row by identity, a page, or every matching row. The table
 * spans keys, so the key is a filter field rather than an argument; and a
 * store promises no live delivery, so there is `scan` instead of `events`.
 */
export interface Reader<Row> {
  /** Whether the whole history recorded before this table's version has reached it. */
  readonly history: Effect.Effect<View.History>;
  readonly get: (
    identity: Identity,
    options?: ReadOptions,
  ) => Effect.Effect<Option.Option<Row>, ReadError, RuntimeContext>;
  readonly list: (
    options?: ListOptions<Row>,
  ) => Effect.Effect<Query.Page<Row>, ReadError, RuntimeContext>;
  readonly scan: (
    options?: Omit<ListOptions<Row>, "after" | "take">,
  ) => Stream.Stream<Row, ReadError, RuntimeContext>;
  /** How the rows `where` selects lag, from commit to store (`_export_lag_ms`). */
  readonly lag: (
    options?: Omit<ListOptions<Row>, "after" | "take" | "orderBy">,
  ) => Effect.Effect<LagSummary, ReadError, RuntimeContext>;
}

export interface TableClass<
  Name extends string,
  From extends ReadonlyArray<View.Source>,
  K extends Key.Any,
  On extends ReadonlyArray<Exportable>,
  M extends Metadata.Fields<M> = {},
  P extends Sensitive.Policy | undefined = undefined,
> extends Projection.ProjectionClass<Name, From, K, On, readonly []> {
  readonly tableName: Name;
  readonly options: Options<M, P>;
  /** The derived row Schema: what each input becomes in the store. */
  readonly Row: RowSchema<On, P>;
  /** The derived read Schema: a stored row with its metadata. */
  readonly Read: ReadSchema<On, M, P>;
  /** The derived table spec. */
  readonly spec: TableSpec;
  /** One of the table's columns, for an engine query: `${Facts.column("envelope.at")}`. */
  column(path: ColumnPath<ReadSchema<On, M, P>["Type"]>): ColumnRef<Name>;
  /** Problems found while deriving the spec; the table's Layer dies with the first. */
  readonly problems: ReadonlyArray<Reason>;
  /** Where this table's rows go. Provided by the store that lists it. */
  readonly Target: Context.Service<TargetKey<Name>, Target>;
  /** The store's reads of this table, rows still JSON. Provided by the store that lists it. */
  readonly RawReader: Context.Service<RawReaderKey<Name>, RawReader>;
  /** Reads of this table, shaped as Domain reads a View. Provided by `reader`. */
  readonly Reader: Context.Service<ReaderKey<Name>, Reader<ReadSchema<On, M, P>["Type"]>>;
  /**
   * The table's projection handler, which writes through `Target`. List it
   * in the model's handlers; it requires the store that lists the table,
   * and a `Sealer` when the table encrypts.
   */
  layer(
    options?: LayerOptions,
  ): Layer.Layer<Projection.ProjectionKey<Name>, never, TargetKey<Name> | SealerOf<P>>;
  /**
   * The table's `Reader`, built on top of the hosted model: it needs the
   * model's progress for this table (for `history` and `atLeast`), the
   * store's raw reads, and a `Sealer` when the table encrypts. The model
   * keeps only what its handlers implement, so a reader built among them
   * would not reach the caller.
   */
  readonly reader: Layer.Layer<
    ReaderKey<Name>,
    never,
    RawReaderKey<Name> | Projection.ProgressKey<Name> | SealerOf<P>
  >;
  /**
   * Promote a rebuilt generation once it has caught up: the stable name then
   * points at it. Built on top of the hosted model, like `reader`.
   */
  promoter(
    options?: LayerOptions,
  ): Layer.Layer<never, never, TargetKey<Name> | Projection.ProgressKey<Name> | RuntimeContext>;
}

// ---------------------------------------------------------------- derivation

/** An aggregate key's column turns its ref into its id; a Schema key's value is stored as it is. */
const keyColumnOf = (key: Key.Any): typeof AggregateKey | typeof Schema.String =>
  Key.isAggregate(key) ? AggregateKey : Schema.String;

const specOf = <M extends Metadata.Fields<M>, P extends Sensitive.Policy | undefined>(
  name: string,
  row: Schema.Top,
  on: ReadonlyArray<Event.Any>,
  options: Options<M, P>,
) => {
  const walked = columnsOf(name, row);
  const sensitive = protect(name, walked.columns, options.sensitive);
  const events = on.map((event) => {
    const derived = eventSpecOf(name, event.tag, event);
    return {
      ...derived,
      ...protectEvent(name, derived.columns, options.sensitive),
      walkProblems: derived.problems,
    };
  });
  const declared = options.metadata ?? {};
  const metadata = metadataOf(name, { ...declared, ...Metadata.builtIn });
  const redefined = Object.keys(declared)
    .filter((path) => path in Metadata.builtIn)
    .map((path) => new MetadataRedefined({ table: name, path }));
  const shape = {
    columns: sensitive.columns,
    metadata: metadata.metadata,
    identity: ["key", "route", "envelope.stream", "envelope.seq"] as const,
    events: events.map(({ tag, columns }) => ({ tag, columns })),
    ...(options.sensitive === undefined ? {} : { sensitive: options.sensitive }),
  } satisfies Pick<TableSpec, "columns" | "metadata" | "identity" | "events" | "sensitive">;
  const spec: TableSpec = {
    table: name,
    name: options.table,
    generation: options.version ?? 0,
    fingerprint: fingerprintOf(shape),
    ...shape,
  };
  const problems: ReadonlyArray<Reason> = [
    ...walked.problems,
    ...sensitive.problems,
    ...events.flatMap((e) => [...e.walkProblems, ...e.problems]),
    ...metadata.problems,
    ...redefined,
  ];
  /** Each event's protected top-level fields, by tag. */
  const protectedFields = new Map(events.map((e) => [e.tag, e.fields] as const));
  return { spec, problems, protectedFields };
};

/** The oldest event of each run: milliseconds from its commit to the run reaching the store, by `domain.export.table`. */
const exportLag = Metric.histogram("domain.export.lag", {
  description: "Milliseconds from commit to an export's store, oldest event per run",
  boundaries: Metric.exponentialBoundaries({ start: 1, factor: 2, count: 22 }),
});
/** Rows written to export stores, by `domain.export.table`. */
const exportRows = Metric.counter("domain.export.rows", {
  description: "Rows written to export stores",
  incremental: true,
});

/**
 * The events' storage Schema under the table's policy, as two views of one
 * Schema: writing takes the declared events (omitted fields are dropped as
 * they encode), reading gives what was stored (`StoredEvent`). Sensitivity is
 * an annotation, known only at runtime, so the Schema is rebuilt from the
 * events' ASTs (`Sensitive.storedEventOf`) and typed here.
 */
const storedEventOf = <On extends ReadonlyArray<Exportable>, P>(
  on: On,
  protectedFields: ReadonlyMap<string, ReadonlySet<string>>,
  policy: Sensitive.Policy | undefined,
) => {
  const stored = Schema.Union(
    on.map((event) =>
      Sensitive.storedEventOf(event, protectedFields.get(event.tag) ?? new Set(), policy),
    ),
  );
  return {
    // Casts, rebuilt from runtime annotations: `write` encodes the declared events, needing the Sealer when the policy encrypts;
    write: stored as unknown as WrittenEvent<On, P>,
    // `read` decodes what the policy stored (omitted fields absent).
    read: stored as unknown as StoredEvent<On, P>,
  };
};

// ---------------------------------------------------------------- the factory

/**
 * Declare a table: a projection whose handler writes each run of its
 * inputs to the store that lists it. Its row is derived from the
 * projection's key and events; event fields annotated `sensitive` are
 * omitted or encrypted as `sensitive` says.
 *
 * A table runs as three Layers: `layer()` is the projection's handler (list
 * it in the model's handlers); `reader` reads it as Domain reads a View; and
 * `promoter()` moves readers and engines to a rebuilt generation once it has
 * caught up. Without the promoter, a version bump leaves the stable name on
 * the old generation in a SQL store, while `reader` (and an Iceberg engine)
 * read the new one as it fills: run the promoter wherever the model is
 * hosted.
 *
 * ### Declaring a table
 * **Example:** Every warehouse fact, by facility
 * ```typescript
 * import * as Export from "@alchemy.run/domain/Export";
 *
 * export class Facts extends Export.Table(
 *   "Facts",
 *   {
 *     from: [Holdings, Task, Order],
 *     key: FacilityId,
 *     keyOf: { Holdings: (e) => e.facility, Task: (e) => e.facility, Order: (e) => e.facility },
 *     on: [ItemPicked, ItemPut, OrderShipped],
 *   },
 *   { table: "facts" },
 * ) {}
 * ```
 *
 * ### Running a table
 * **Example:** The handler, batched, beside its reader and promoter
 * ```typescript
 * import * as Layer from "effect/Layer";
 *
 * // Listed in the model's handlers.
 * export const FactsLive = Facts.layer({ batch: { size: 1000, wait: "2 seconds" } });
 *
 * // Built on top of the hosted model, which provides the table's progress.
 * export const FactsUpkeep = Layer.mergeAll(Facts.reader, Facts.promoter()).pipe(
 *   Layer.provide(Warehouse.place(Facts)),
 * );
 * ```
 *
 * ### Rebuilding a table
 * **Example:** A change the store cannot take in place
 * ```typescript
 * export class Facts extends Export.Table("Facts", definition, { table: "facts", version: 1 }) {}
 * // `facts_v1` fills from history; the promoter points `facts` at it once it has caught up.
 * ```
 *
 * ### Reading a table
 * **Example:** A page of one facility's facts, after the caller's write
 * ```typescript
 * const facts = yield* Facts.Reader;
 * const page = yield* facts.list({
 *   where: { key: "dock-7" },
 *   orderBy: { position: "desc" },
 *   atLeast: receipt,
 * });
 * ```
 *
 * @primitive
 */
export const make = <
  const Name extends string,
  const From extends ReadonlyArray<View.Source>,
  K extends Key.Any,
  const On extends ReadonlyArray<Exportable>,
  const M extends Metadata.Fields<M> = {},
  const P extends Sensitive.Policy | undefined = undefined,
>(
  name: Name,
  definition: Projection.Definition<From, K, On, readonly []>,
  options: Options<M, P>,
  annotations: Annotations = {},
): TableClass<Name, From, K, On, M, P> => {
  const Base = Projection.make(name, definition, annotations);
  const keyColumn = keyColumnOf(definition.key);
  const { spec, problems, protectedFields } = specOf(
    name,
    Schema.Struct({
      key: keyColumn,
      route: Route,
      position: Schema.Int,
      envelope: Envelope,
      event: Schema.Union(definition.on),
    }),
    definition.on,
    options,
  );
  const event = storedEventOf<On, P>(definition.on, protectedFields, options.sensitive);
  const Row = Schema.Struct({
    key: keyColumn,
    route: Route,
    position: Schema.Int,
    envelope: Envelope,
    event: event.write,
  });
  // A store holds JSON. `toCodecJson` encodes a whole run in one pass (`Schema.encode` alone
  // would leave `envelope.at` a `DateTime.Utc`); reads decode a page in one pass the same way,
  // with the metadata the store recorded beside each row.
  const encodeRun = Schema.encodeEffect(Schema.Array(Schema.toCodecJson(Row)));
  const Read = Schema.Struct(readFields<On, M, P>(event.read, options.metadata));
  const ReadJson = Schema.toCodecJson(Read);
  const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ReadJson));
  const decodeRow = Schema.decodeUnknownEffect(ReadJson);
  // A filter as a Domain read receives it: sent as JSON text (a date becomes its ISO string),
  // decoded with `FilterJson`. `FilterJson` alone keeps a `DateTime` operand an object, which a
  // store, comparing against JSON rows, cannot order.
  const FilterWire = Schema.fromJsonString(FilterJson);
  const encodeWhere = (where: unknown) =>
    Schema.encodeUnknownEffect(FilterWire)(where).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(FilterWire)),
    );

  const Target = Context.Service<TargetKey<Name>, Target>()(
    `alchemy/Domain/Export/Table/${name}/Target`,
  );
  const RawReader = Context.Service<RawReaderKey<Name>, RawReader>()(
    `alchemy/Domain/Export/Table/${name}/RawReader`,
  );
  const Reader = Context.Service<ReaderKey<Name>, Reader<typeof Read.Type>>()(
    `alchemy/Domain/Export/Table/${name}/Reader`,
  );

  const dieOnProblems =
    problems[0] === undefined
      ? Effect.void
      : Effect.die(new DefinitionError({ reason: problems[0] }));

  /** The projection's handler: encode the whole run with `Row` once, write it through `Target`. */
  const handler = (layerOptions: LayerOptions) =>
    Effect.gen(function* () {
      yield* dieOnProblems;
      const target = yield* Target;
      // The table's own services (a `Sealer`, when it encrypts), for encoding each run.
      const services = yield* Effect.context<SealerOf<P>>();
      const transient = Schedule.exponential("100 millis").pipe(
        Schedule.jittered,
        Schedule.upTo({ duration: layerOptions.transient ?? "5 seconds" }),
      );
      // The store is made ready by the first run, where the host's RuntimeContext exists
      // (bindings need it); a store that cannot take this spec fails that run with `SchemaDrift`,
      // and the key waits until the table's version is bumped. `ensure` is idempotent.
      let ensured = false;
      return Effect.fn(`Export.${name}`)(
        function* (batch: ReadonlyArray<Projection.InputOf<typeof Base>>) {
          const first = batch[0];
          const last = batch[batch.length - 1];
          if (first === undefined || last === undefined) return;
          if (!ensured) {
            yield* target.ensure(spec);
            ensured = true;
          }
          const rows = yield* encodeRun(batch).pipe(Effect.provide(services));
          const ingestedAt = yield* DateTime.now;
          yield* target
            .write(spec, { rows, ingestedAt })
            .pipe(
              Effect.retry({ while: (error) => error._tag === "Unavailable", schedule: transient }),
            );
          let oldest = Number.POSITIVE_INFINITY;
          for (const input of batch)
            oldest = Math.min(oldest, DateTime.toEpochMillis(input.envelope.at));
          const attributes = { "domain.export.table": name };
          yield* Telemetry.record(
            exportLag,
            attributes,
            Math.max(DateTime.toEpochMillis(ingestedAt) - oldest, 0),
          );
          yield* Telemetry.record(exportRows, attributes, batch.length);
        },
        // A run that still fails (an encoding failure, a statement the store refused, a store still down)
        // dies; the host retries the run every 10 seconds and the key waits.
        Effect.orDie,
      );
    });

  /** The decoded reader over the store's raw reads, consistent through the table's own progress. */
  const reader = Layer.effect(
    Reader,
    Effect.gen(function* () {
      const raw = yield* RawReader;
      const progress = yield* Base.Progress;
      const services = yield* Effect.context<SealerOf<P>>();
      const failed = (issue: unknown) => new RowDecodeFailed({ table: name, issue: String(issue) });
      const decode = (row: EncodedRow) =>
        decodeRow(row).pipe(Effect.mapError(failed), Effect.provide(services));
      /** Wait for every receipt in `atLeast`, as a View read does. */
      const caughtUp = (options: ReadOptions | undefined) =>
        Effect.forEach(
          Query.receiptsOf(options?.atLeast),
          (receipt) =>
            progress.caughtUp(
              receipt,
              options?.timeout === undefined ? undefined : { timeout: options.timeout },
            ),
          { discard: true },
        );
      /** The request a store receives: the filter as a read receives it over the wire. */
      const requestOf = (
        options: Omit<ListOptions<typeof Read.Type>, "after" | "take"> | undefined,
      ) =>
        (options?.where === undefined
          ? Effect.succeed(undefined)
          : encodeWhere(options.where)
        ).pipe(
          // A typed `Filter` always encodes; a failure here is a bug, not a read error.
          Effect.orDie,
          Effect.map((where): ReadRequest => ({
            // A cast: `FilterJson` is `Codec<unknown>`; its output is a `Filter` as it crosses the wire, which Domain hands `matches` the same way (Api.ts).
            where: where as Filter<Schema.JsonObject> | undefined,
            orderBy: options?.orderBy,
          })),
        );
      return {
        history: progress.history,
        get: (identity, options) =>
          caughtUp(options).pipe(
            Effect.andThen(raw.get(identity)),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeedNone,
                onSome: (row) => Effect.asSome(decode(row)),
              }),
            ),
          ),
        list: (options) =>
          caughtUp(options).pipe(
            Effect.andThen(requestOf(options)),
            Effect.flatMap((request) =>
              raw.list(request, {
                after: options?.after,
                take: Math.min(Math.max(options?.take ?? 50, 1), 500),
              }),
            ),
            Effect.flatMap(({ entries, cursor }) =>
              decodeRows(entries).pipe(
                Effect.mapError(failed),
                Effect.provide(services),
                Effect.map((rows) => ({ entries: rows, cursor })),
              ),
            ),
          ),
        scan: (options) =>
          Stream.unwrap(
            caughtUp(options).pipe(
              Effect.andThen(requestOf(options)),
              Effect.map((request) => raw.scan(request).pipe(Stream.mapEffect(decode))),
            ),
          ),
        lag: (options) =>
          caughtUp(options).pipe(Effect.andThen(requestOf(options)), Effect.flatMap(raw.lag)),
      } satisfies Reader<typeof Read.Type>;
    }),
  );

  /** Poll the hosted progress; promote once the whole history has reached this generation. */
  const promoter = (layerOptions: LayerOptions) =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const progress = yield* Base.Progress;
        const target = yield* Target;
        const every = Schedule.spaced(layerOptions.promoteEvery ?? "5 seconds");
        // Wait until the whole history has reached this generation, then point the stable name at it.
        const promoteWhenComplete = progress.history.pipe(
          Effect.repeat({ until: (history) => history.complete, schedule: every }),
          Effect.andThen(
            target.promote(spec).pipe(
              Effect.tapError((error) =>
                Effect.logWarning(
                  `Export.${name}: promoting generation ${spec.generation} failed; retrying`,
                  error,
                ),
              ),
              Effect.retry({ while: (error) => error._tag === "Unavailable", schedule: every }),
            ),
          ),
          Effect.orDie,
        );
        yield* Effect.forkScoped(promoteWhenComplete);
      }),
    );

  return class extends Base {
    static readonly tableName = name;
    static readonly options = options;
    static readonly Row = Row;
    static readonly Read = Read;
    static readonly spec = spec;
    static column(path: ColumnPath<typeof Read.Type>): ColumnRef<Name> {
      return { [ColumnTypeId]: ColumnTypeId, tableName: name, path };
    }
    static readonly problems = problems;
    static readonly Target = Target;
    static readonly RawReader = RawReader;
    static readonly Reader = Reader;
    static layer(layerOptions: LayerOptions = {}) {
      return Base.toLayer(handler(layerOptions), {
        ...(layerOptions.batch === undefined ? {} : { batch: layerOptions.batch }),
        ...(options.version === undefined ? {} : { version: options.version }),
      });
    }
    static readonly reader = reader;
    static promoter(layerOptions: LayerOptions = {}) {
      return promoter(layerOptions);
    }
  };
};
