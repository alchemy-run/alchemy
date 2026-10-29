import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as ClusterSchema from "effect/cluster/ClusterSchema";
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine";
import * as DeliverAt from "effect/cluster/DeliverAt";
import * as Entity from "effect/cluster/Entity";
import type * as MessageStorage from "effect/cluster/MessageStorage";
import * as Sharding from "effect/cluster/Sharding";
import type * as ShardingConfig from "effect/cluster/ShardingConfig";
import * as SingleRunner from "effect/cluster/SingleRunner";
import type { ConfigError } from "effect/Config";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PrimaryKey from "effect/PrimaryKey";
import * as PubSub from "effect/PubSub";
import * as Rpc from "effect/rpc/Rpc";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type * as Statement from "effect/sql/Statement";
import * as Stream from "effect/Stream";
import type { WorkflowEngine } from "effect/workflow";
import type * as Aggregate from "./Aggregate.ts";
import { AlreadyCancelled, AlreadyExecuted, NotScheduled } from "./Aggregate.ts";
import { isAfter, mergeCheckpoints } from "./InMemory.ts";
import {
  type Accepted,
  type AggregateKit,
  type AggregateStore,
  type Delivery,
  emptySnapshot,
  emptyStreamMeta,
  type Json,
  Platform,
  type PolicyKit,
  type PolicyStore,
  type ProjectionKit,
  type ProjectionStore,
  type SendResult,
  type StoredEvent,
  type StreamEntry,
  type StreamKit,
  type StreamStore,
  type StreamMeta,
  type StreamWrite,
  type ViewEntry,
  type ViewKit,
  type ViewStore,
  type ViewSnapshot,
} from "./Platform.ts";

/**
 * Options for {@link layer}.
 */
export interface Options {
  /**
   * Prefix of the host's tables (`domain_aggregates`, `domain_events`, …).
   * Two models with different prefixes can share one database and one cluster.
   * @default "domain"
   */
  readonly tablePrefix?: string;
  /**
   * Create the host's tables when the Layer builds. Set `false` when
   * {@link layerMigrations} runs in a deploy step.
   * @default true
   */
  readonly migrations?: boolean;
  /**
   * How often a live read (`watch`, `events`) reads its key again, to see
   * commits of other runners. Commits of this runner are seen at once.
   * @default 250
   */
  readonly watchMillis?: number;
  /**
   * The backstop for deliveries and timers: every `intervalMillis`, forward
   * outbox rows and send again the timers that are older than `afterMillis`.
   * @default { intervalMillis: 10_000, afterMillis: 30_000 }
   */
  readonly sweep?: { readonly intervalMillis: number; readonly afterMillis: number };
  /**
   * How many view entries to keep per key. A key keeps its newest `keep`
   * entries; `list` and `events` from an older cursor start at the oldest
   * kept entry. `"all"` keeps every entry.
   * @default 50
   */
  readonly viewEntries?: number | "all";
  /**
   * Stop an idle aggregate, view, policy or projection instance after this
   * time. The next message starts it again.
   * @default the cluster's `entityMaxIdleTime`
   */
  readonly entityMaxIdleTime?: Duration.Input;
}

/**
 * Options for {@link layerSingleRunner}.
 */
export interface SingleRunnerOptions extends Options {
  /**
   * Overrides of the cluster's configuration, on top of
   * `ShardingConfig.layerFromEnv`.
   * @default { entityMessagePollInterval: "1 second" }
   */
  readonly shardingConfig?: Partial<ShardingConfig.ShardingConfig["Service"]>;
  /**
   * Where the runner keeps its shard locks. `"sql"` locks shards in the
   * database, so a second process on the same database waits for them.
   * `"memory"` is for one process only: SQLite and tests.
   * @default "sql"
   */
  readonly runnerStorage?: "sql" | "memory";
}

// ---------------------------------------------------------------- protocol

const JsonValue = Schema.Unknown;

/**
 * A command to an aggregate instance. Volatile: the receipt row, written in
 * the command's own transaction, dedupes it.
 *
 * No handler of this host uses `ClusterSchema.WithTransaction`, and no
 * cluster message or reply is written inside a Domain transaction. On MySQL
 * and MariaDB a deadlock rolls back the handler's transaction, and the
 * cluster then saves the reply again in autocommit, so a reply can be stored
 * without the writes it reports
 * (https://github.com/Effect-TS/effect/issues/10162). Deliveries and timers
 * go out after the commit, from the outbox and the schedules table.
 */
const SendRpc = Rpc.make("Send", {
  payload: { command: JsonValue, meta: JsonValue },
  success: JsonValue,
}).annotate(ClusterSchema.Uninterruptible, "server");

/** Store a timer for a command, then send its `Fire`. */
const ScheduleRpc = Rpc.make("Schedule", {
  payload: { command: JsonValue, meta: JsonValue, at: Schema.Number },
  success: JsonValue,
}).annotate(ClusterSchema.Uninterruptible, "server");

/** Cancel the timer of a command. */
const UnscheduleRpc = Rpc.make("Unschedule", {
  payload: { commandId: Schema.String },
  success: JsonValue,
}).annotate(ClusterSchema.Uninterruptible, "server");

/** A timer that is due. It runs the command only while its token is the stored one. */
class Fire extends Schema.Class<Fire>("alchemy/Domain/Cluster/Fire")({
  commandId: Schema.String,
  token: Schema.String,
  at: Schema.Number,
}) {
  [PrimaryKey.symbol]() {
    return `${this.commandId}/${this.token}`;
  }
  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.at);
  }
}
const FireRpc = Rpc.make("Fire", { payload: Fire }).annotate(ClusterSchema.Persisted, true);

/** One delivery to a view, policy or projection key. The `(source, seq)` key drops a repeat. */
class Deliver extends Schema.Class<Deliver>("alchemy/Domain/Cluster/Deliver")({
  delivery: JsonValue,
}) {
  [PrimaryKey.symbol]() {
    const delivery = this.delivery as Delivery;
    return `${delivery.source}#${delivery.seq}`;
  }
}
const DeliverRpc = Rpc.make("Deliver", { payload: Deliver }).annotate(
  ClusterSchema.Persisted,
  true,
);

/** Run a projection key's waiting inputs: a short batch that waited long enough, or a retry. */
class Flush extends Schema.Class<Flush>("alchemy/Domain/Cluster/Flush")({ at: Schema.Number }) {
  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.at);
  }
}
const FlushRpc = Rpc.make("Flush", { payload: Flush }).annotate(ClusterSchema.Persisted, true);

const aggregateEntity = (type: string) =>
  Entity.make(type, [SendRpc, ScheduleRpc, UnscheduleRpc, FireRpc]);
const viewEntity = (type: string) => Entity.make(type, [DeliverRpc]);
const policyEntity = (type: string) => Entity.make(type, [DeliverRpc]);
const projectionEntity = (type: string) => Entity.make(type, [DeliverRpc, FlushRpc]);

// ---------------------------------------------------------------- constants

const DefectTag = "alchemy/Domain/Defect";

/** Return a defect as data, so the caller dies with it instead of the entity restarting. */
const reportDefects = <A, R>(effect: Effect.Effect<A, never, R>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({ [DefectTag]: Cause.pretty(cause) } as unknown as A),
    ),
  );

const unwrapDefects = <A>(value: unknown): Effect.Effect<A> =>
  value !== null && typeof value === "object" && DefectTag in value
    ? Effect.die(new Error(String((value as Record<string, unknown>)[DefectTag])))
    : Effect.succeed(value as A);

/**
 * How long a call keeps trying while the target's mailbox is full: from
 * 100ms to 2s, about a minute in total, like the Durable Object host.
 */
const TRANSIT_RETRY = {
  schedule: Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("2 seconds")]),
  times: 35,
} as const;

/** What `token` holds once a timer is cancelled; never a timer token. */
const CANCELLED = "cancelled";

/** How long a failed projection run waits before it runs again. */
const PROJECTION_RETRY_MS = 10_000;

/** A failed policy handler runs again from 1s, 5 times, then the delivery is logged and dropped. */
const POLICY_RETRY = { schedule: Schedule.exponential("1 second"), times: 5 } as const;

/** How long one forward may wait for its target (for example, an entity this runner hosts later). */
const FORWARD_TIMEOUT = "30 seconds";

/** Wake the storage reader at a due time this close; later ones wait for its poll. */
const WAKE_WITHIN_MS = 60_000;

/** Outbox rows a drain reads at a time. */
const DRAIN_BATCH = 100;

// ---------------------------------------------------------------- tables

const tableNames = (prefix: string) => ({
  aggregates: `${prefix}_aggregates`,
  events: `${prefix}_events`,
  receipts: `${prefix}_receipts`,
  schedules: `${prefix}_schedules`,
  outbox: `${prefix}_outbox`,
  views: `${prefix}_views`,
  viewEntries: `${prefix}_view_entries`,
  projections: `${prefix}_projections`,
  projectionInputs: `${prefix}_projection_inputs`,
  streams: `${prefix}_streams`,
  streamEntries: `${prefix}_stream_entries`,
  migrations: `${prefix}_migrations`,
});

/**
 * The host's migrations, for a project that runs one `Migrator` for every
 * schema. History goes in the migrator's table; {@link layerMigrations} and
 * {@link layer} use `<prefix>_migrations`.
 */
export const migrations = (options?: { readonly tablePrefix?: string }): Migrator.Loader => {
  const t = tableNames(options?.tablePrefix ?? "domain");
  return Migrator.fromRecord({
    "0001_create_tables": Effect.gen(function* () {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms();
      // MySQL TEXT holds 64 KB; a JSON state can be larger.
      const text = sql.onDialectOrElse({
        mysql: () => "LONGTEXT",
        mssql: () => "NVARCHAR(MAX)",
        orElse: () => "TEXT",
      });
      const big = sql.onDialectOrElse({ sqlite: () => "INTEGER", orElse: () => "BIGINT" });
      const serial = sql.onDialectOrElse({
        mysql: () => "BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY",
        pg: () => "BIGSERIAL PRIMARY KEY",
        mssql: () => "BIGINT IDENTITY(1,1) PRIMARY KEY",
        orElse: () => "INTEGER PRIMARY KEY AUTOINCREMENT",
      });
      const name = "VARCHAR(150) NOT NULL";
      const id = "VARCHAR(255) NOT NULL";
      const create = (table: string, body: string) =>
        sql.onDialectOrElse({
          mssql: () =>
            sql.unsafe(`IF OBJECT_ID(N'${table}', N'U') IS NULL CREATE TABLE ${table} (${body})`),
          orElse: () => sql.unsafe(`CREATE TABLE IF NOT EXISTS ${table} (${body})`),
        });
      yield* create(
        t.aggregates,
        `name ${name}, id ${id}, state ${text}, version INTEGER NOT NULL, PRIMARY KEY (name, id)`,
      );
      yield* create(
        t.events,
        `name ${name}, id ${id}, seq INTEGER NOT NULL, event ${text} NOT NULL, envelope ${text} NOT NULL, at ${big} NOT NULL, PRIMARY KEY (name, id, seq)`,
      );
      yield* create(
        t.receipts,
        `name ${name}, id ${id}, command_id VARCHAR(255) NOT NULL, result ${text} NOT NULL, at ${big} NOT NULL, PRIMARY KEY (name, id, command_id)`,
      );
      yield* create(
        t.schedules,
        `name ${name}, id ${id}, command_id VARCHAR(255) NOT NULL, token VARCHAR(64) NOT NULL, due ${big} NOT NULL, command ${text} NOT NULL, meta ${text} NOT NULL, at ${big} NOT NULL, PRIMARY KEY (name, id, command_id)`,
      );
      yield* create(
        t.outbox,
        `seq ${serial}, origin VARCHAR(500) NOT NULL, delivery ${text} NOT NULL, at ${big} NOT NULL`,
      );
      yield* create(
        t.views,
        `name ${name}, id ${id}, snapshot ${text} NOT NULL, PRIMARY KEY (name, id)`,
      );
      yield* create(
        t.viewEntries,
        `name ${name}, id ${id}, seq INTEGER NOT NULL, event ${text} NOT NULL, envelope ${text} NOT NULL, state ${text} NOT NULL, PRIMARY KEY (name, id, seq)`,
      );
      yield* create(
        t.projections,
        `name ${name}, id ${id}, accepted INTEGER NOT NULL, processed INTEGER NOT NULL, intake ${text} NOT NULL, checkpoints ${text} NOT NULL, PRIMARY KEY (name, id)`,
      );
      yield* create(
        t.projectionInputs,
        `name ${name}, id ${id}, position INTEGER NOT NULL, delivery ${text} NOT NULL, at ${big} NOT NULL, PRIMARY KEY (name, id, position)`,
      );
      yield* create(
        t.streams,
        `name ${name}, id ${id}, meta ${text} NOT NULL, PRIMARY KEY (name, id)`,
      );
      yield* create(
        t.streamEntries,
        `name ${name}, id ${id}, seq INTEGER NOT NULL, event ${text} NOT NULL, envelope ${text} NOT NULL, PRIMARY KEY (name, id, seq)`,
      );
      // The migrator runs each migration once, so the indexes need no IF NOT EXISTS.
      yield* sql.unsafe(`CREATE INDEX ${t.outbox}_origin_idx ON ${t.outbox} (origin, seq)`);
      yield* sql.unsafe(`CREATE INDEX ${t.outbox}_at_idx ON ${t.outbox} (at)`);
      yield* sql.unsafe(`CREATE INDEX ${t.receipts}_at_idx ON ${t.receipts} (at)`);
      yield* sql.unsafe(`CREATE INDEX ${t.schedules}_due_idx ON ${t.schedules} (due)`);
    }),
  });
};

const runMigrations = (prefix: string) =>
  Migrator.make({})({
    loader: migrations({ tablePrefix: prefix }),
    table: tableNames(prefix).migrations,
  }).pipe(Effect.asVoid, Effect.orDie);

/**
 * Create the host's tables and nothing else, for a deploy step that runs
 * with a schema-owner connection before the runners start. Pair it with
 * `SqlMessageStorage.layerMigrations` and `SqlRunnerStorage.layerMigrations`
 * from `effect/cluster`, and give the runners {@link layer} with
 * `migrations: false`.
 *
 * ### Creating the tables in a deploy step
 * **Example:** One deploy step for the host and the cluster
 * ```typescript
 * import * as Cluster from "@alchemy.run/domain/Cluster";
 * import { SqlMessageStorage, SqlRunnerStorage } from "effect/cluster";
 * import * as Layer from "effect/Layer";
 *
 * export const Migrate = Layer.mergeAll(
 *   Cluster.layerMigrations(),
 *   SqlMessageStorage.layerMigrations({}),
 *   SqlRunnerStorage.layerMigrations({}),
 * );
 * ```
 *
 * @layer
 */
export const layerMigrations = (options?: {
  readonly tablePrefix?: string;
}): Layer.Layer<never, never, SqlClient.SqlClient> =>
  Layer.effectDiscard(runMigrations(options?.tablePrefix ?? "domain"));

// ---------------------------------------------------------------- the platform

interface AggregateRow {
  readonly state: string | null;
  readonly version: number | string;
}

interface ScheduleRow {
  readonly token: string;
  readonly command: string;
  readonly meta: string;
}

interface ProjectionMeta {
  readonly accepted: number;
  readonly processed: number;
  readonly intake: Readonly<Record<string, number>>;
  readonly checkpoints: Readonly<Record<string, number>>;
}

const emptyProjectionMeta: ProjectionMeta = {
  accepted: 0,
  processed: 0,
  intake: {},
  checkpoints: {},
};

const parse = (text: string | null): Json => (text === null ? null : JSON.parse(text));

const make = (options: Options) =>
  Effect.gen(function* () {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms();
    const sharding = yield* Sharding.Sharding;
    const scope = yield* Effect.scope;
    const prefix = options.tablePrefix ?? "domain";
    const watchMillis = options.watchMillis ?? 250;
    const sweep = options.sweep ?? { intervalMillis: 10_000, afterMillis: 30_000 };
    const keep = options.viewEntries ?? 50;
    const t = tableNames(prefix);
    const table = {
      aggregates: sql(t.aggregates),
      events: sql(t.events),
      receipts: sql(t.receipts),
      schedules: sql(t.schedules),
      outbox: sql(t.outbox),
      views: sql(t.views),
      viewEntries: sql(t.viewEntries),
      projections: sql(t.projections),
      projectionInputs: sql(t.projectionInputs),
      streams: sql(t.streams),
      streamEntries: sql(t.streamEntries),
    };
    // Two models with different prefixes on one cluster get their own entity types.
    const typeOf = (kind: string, name: string) =>
      prefix === "domain" ? `Domain.${kind}/${name}` : `Domain.${kind}/${prefix}/${name}`;

    if (options.migrations !== false) yield* runMigrations(prefix);

    const now = Clock.currentTimeMillis;
    /** Insert rows, or nothing when there are none. */
    const insertAll = (
      into: Statement.Identifier,
      rows: ReadonlyArray<Record<string, unknown>>,
    ): Effect.Effect<void, SqlError> =>
      Arr.isReadonlyArrayNonEmpty(rows)
        ? Effect.asVoid(sql`INSERT INTO ${into} ${sql.insert(rows)}`)
        : Effect.void;
    const limit = (n: number) =>
      sql.onDialectOrElse({
        mssql: () => sql.literal(`OFFSET 0 ROWS FETCH NEXT ${n} ROWS ONLY`),
        orElse: () => sql.literal(`LIMIT ${n}`),
      });

    // ------------------------------------------------------------ local wake-ups

    /**
     * Keys committed by this runner. A live read of a key reads it again at
     * once; commits of other runners are seen on the next `watchMillis` tick.
     */
    const commits = yield* PubSub.unbounded<string>();
    const announce = (key: string) => PubSub.publish(commits, key).pipe(Effect.asVoid);
    /** Fires now, then on every local commit of `key` and every `watchMillis`. */
    const ticks = (key: string): Stream.Stream<void> =>
      Stream.merge(
        Stream.tick(watchMillis),
        Stream.fromPubSub(commits).pipe(
          Stream.filter((committed) => committed === key),
          Stream.as(undefined),
        ),
      );
    /** The current value, then every new one, by `version`. */
    const watch = <A>(key: string, read: Effect.Effect<A>, version: (a: A) => number | string) =>
      ticks(key).pipe(
        Stream.mapEffect(() => read),
        Stream.changesWith((a, b) => version(a) === version(b)),
      );
    /** Rows with `seq > after`, then new ones. */
    const follow = <A>(
      key: string,
      after: number,
      read: (after: number) => Effect.Effect<ReadonlyArray<A>>,
      seqOf: (a: A) => number,
    ): Stream.Stream<A> =>
      Stream.suspend(() => {
        let last = after;
        return ticks(key).pipe(
          Stream.mapEffect(() => read(last)),
          Stream.flatMap((fresh) => {
            if (fresh.length > 0) last = seqOf(fresh[fresh.length - 1]!);
            return Stream.fromIterable(fresh);
          }),
        );
      });

    /** Wake the storage reader when a near timer is due, so it fires on time. */
    const wakeAt = (at: number) =>
      Effect.gen(function* () {
        const delay = at - (yield* now);
        if (delay > WAKE_WITHIN_MS) return;
        yield* Effect.sleep(Math.max(0, delay)).pipe(
          Effect.andThen(sharding.pollStorage),
          Effect.forkIn(scope),
        );
      });

    // ------------------------------------------------------------ clients

    const register = (
      entity: Entity.Entity<string, any>,
      handlers: Effect.Effect<any, never, any>,
    ): Effect.Effect<void> =>
      sharding
        .registerEntity(entity, handlers as never, {
          concurrency: 1,
          maxIdleTime: options.entityMaxIdleTime,
        })
        .pipe(Effect.provideService(Scope.Scope, scope)) as Effect.Effect<void>;

    const clients = new Map<string, (id: string) => any>();
    const clientOf = (type: string, entity: () => Entity.Entity<string, any>) =>
      Effect.suspend(() => {
        const found = clients.get(type);
        if (found) return Effect.succeed(found);
        return sharding
          .makeClient(entity())
          .pipe(Effect.tap((client) => Effect.sync(() => clients.set(type, client))));
      });
    const call = <A>(effect: Effect.Effect<unknown, unknown>): Effect.Effect<A> =>
      effect.pipe(Effect.retry(TRANSIT_RETRY), Effect.orDie, Effect.flatMap(unwrapDefects<A>));
    const aggregateClient = (name: string) =>
      clientOf(typeOf("Aggregate", name), () => aggregateEntity(typeOf("Aggregate", name)));

    /** Send a delivery to its target's entity, durably. A repeat is dropped by its key. */
    const forward = (delivery: Delivery) =>
      Effect.gen(function* () {
        const { kind, name } = delivery.target;
        const type =
          kind === "view"
            ? typeOf("View", name)
            : kind === "policy"
              ? typeOf("Policy", name)
              : typeOf("Projection", name);
        const client = yield* clientOf(type, () =>
          kind === "projection" ? projectionEntity(type) : viewEntity(type),
        );
        yield* (
          client(delivery.key).Deliver(Deliver.make({ delivery }), {
            discard: true,
          }) as Effect.Effect<void, unknown>
        ).pipe(Effect.retry(TRANSIT_RETRY));
      });

    // ------------------------------------------------------------ outbox

    /**
     * Rows written in the transaction that commits their cause, forwarded
     * after the commit by the instance that wrote them, and by the sweeper if
     * that instance dies first. A source's rows go out in order, one at a
     * time, and a row is deleted only after its message is stored. Two
     * forwarders of one source keep that order: the target reads its
     * mailbox in insertion order, and a row goes out only after every
     * earlier row of its source went out.
     */
    const stage = (origin: string, deliveries: ReadonlyArray<Delivery>) =>
      Effect.gen(function* () {
        if (deliveries.length === 0) return;
        const at = yield* now;
        yield* insertAll(
          table.outbox,
          deliveries.map((delivery) => ({ origin, delivery: JSON.stringify(delivery), at })),
        );
      });
    const drainOnce = (origin: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          const rows = yield* sql<{
            seq: number | string;
            delivery: string;
          }>`SELECT seq, delivery FROM ${table.outbox} WHERE origin = ${origin} ORDER BY seq ${limit(DRAIN_BATCH)}`;
          if (rows.length === 0) return;
          for (const row of rows) {
            yield* forward(JSON.parse(row.delivery) as Delivery).pipe(
              Effect.timeout(FORWARD_TIMEOUT),
            );
          }
          yield* sql`DELETE FROM ${table.outbox} WHERE origin = ${origin} AND seq <= ${Number(rows[rows.length - 1]!.seq)}`;
          if (rows.length < DRAIN_BATCH) return;
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Domain.Cluster: forwarding ${origin} failed; the sweeper retries`,
            cause,
          ),
        ),
      );
    // One drain per origin in this process; a kick during a drain runs it once more.
    const draining = new Map<string, boolean>();
    const kick = (origin: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (draining.has(origin)) {
          draining.set(origin, true);
          return Effect.void;
        }
        draining.set(origin, false);
        const loop: Effect.Effect<void> = drainOnce(origin).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (!draining.get(origin)) return Effect.void;
              draining.set(origin, false);
              return loop;
            }),
          ),
        );
        return loop.pipe(
          Effect.ensuring(Effect.sync(() => draining.delete(origin))),
          Effect.forkIn(scope),
          Effect.asVoid,
        );
      });

    // ------------------------------------------------------------ the sweeper

    const sendFire = (aggregate: string, id: string, fire: Fire) =>
      Effect.gen(function* () {
        const client = yield* aggregateClient(aggregate);
        yield* (client(id).Fire(fire, { discard: true }) as Effect.Effect<void, unknown>).pipe(
          Effect.retry(TRANSIT_RETRY),
          Effect.orDie,
        );
        yield* wakeAt(fire.at);
      });

    /**
     * Forward outbox rows older than `afterMillis`, and send again the
     * `Fire` of timers due that long ago. At start (`everyTimer`), every
     * pending timer: a process may have died between storing a timer and
     * sending its `Fire`, whenever it is due.
     */
    const sweepOnce = (afterMillis: number, everyTimer = false) =>
      Effect.gen(function* () {
        const cutoff = (yield* now) - afterMillis;
        const origins = yield* sql<{
          origin: string;
        }>`SELECT DISTINCT origin FROM ${table.outbox} WHERE at <= ${cutoff}`;
        yield* Effect.forEach(origins, ({ origin }) => kick(origin), { discard: true });
        // A timer whose `Fire` was never sent (a crash after its commit). Sending
        // a known one again is dropped by its key.
        const timers = yield* sql<{
          name: string;
          id: string;
          command_id: string;
          token: string;
          due: number | string;
        }>`SELECT name, id, command_id, token, due FROM ${table.schedules} WHERE token <> ${CANCELLED} AND due <= ${everyTimer ? Number.MAX_SAFE_INTEGER : cutoff}`;
        yield* Effect.forEach(
          timers,
          (row) =>
            sendFire(
              row.name,
              row.id,
              Fire.make({ commandId: row.command_id, token: row.token, at: Number(row.due) }),
            ),
          { discard: true },
        );
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Domain.Cluster: sweep failed", cause)),
      );

    yield* sharding
      .registerSingleton(
        `Domain.Cluster/${prefix}/sweep`,
        // At start, everything a dead process left; then only what is late.
        sweepOnce(0, true).pipe(
          Effect.andThen(
            sweepOnce(sweep.afterMillis).pipe(Effect.delay(sweep.intervalMillis), Effect.forever),
          ),
        ),
      )
      .pipe(Effect.provideService(Scope.Scope, scope));

    // ------------------------------------------------------------ aggregates

    const aggregate = (_aggregate: Aggregate.Any, kit: AggregateKit) =>
      Effect.gen(function* (): Effect.fn.Return<AggregateStore> {
        const type = typeOf("Aggregate", kit.name);
        const entity = aggregateEntity(type);
        const keyOf = (id: string) => `${type}/${id}`;

        const loadRow = (id: string) =>
          sql<AggregateRow>`SELECT state, version FROM ${table.aggregates} WHERE name = ${kit.name} AND id = ${id}`.pipe(
            Effect.map((rows) => rows[0]),
          );
        const receiptOf = (id: string, commandId: string) =>
          sql<{
            result: string;
          }>`SELECT result FROM ${table.receipts} WHERE name = ${kit.name} AND id = ${id} AND command_id = ${commandId}`.pipe(
            Effect.map((rows) =>
              rows[0] ? (JSON.parse(rows[0].result) as SendResult) : undefined,
            ),
          );
        const eventsAfter = (id: string, after: number) =>
          sql<{
            event: string;
            envelope: string;
          }>`SELECT event, envelope FROM ${table.events} WHERE name = ${kit.name} AND id = ${id} AND seq > ${after} ORDER BY seq`.pipe(
            Effect.map((rows) =>
              rows.map((row): StoredEvent => ({
                event: JSON.parse(row.event),
                envelope: JSON.parse(row.envelope),
              })),
            ),
            Effect.orDie,
          );
        const current = (id: string) =>
          loadRow(id).pipe(
            Effect.map((row) => ({
              state: row ? parse(row.state) : null,
              version: row ? Number(row.version) : 0,
            })),
            Effect.orDie,
          );

        /**
         * Decide and commit one command. Callers run it inside a transaction
         * on the instance's entity, so commands run one at a time.
         */
        const commit = (id: string, command: Json, meta: Aggregate.SendMeta) =>
          Effect.gen(function* () {
            const duplicate = yield* receiptOf(id, meta.commandId);
            if (duplicate) return { sent: duplicate, delivered: false };
            const row = yield* loadRow(id);
            const version = row ? Number(row.version) : 0;
            const at = yield* now;
            const result = yield* kit.handle({
              id,
              state: row ? parse(row.state) : null,
              version,
              command,
              commandId: meta.commandId,
              context: meta.context,
              now: at,
              correlationId: meta.correlationId,
              trace: meta.trace,
              link: meta.link,
            });
            if (result._tag === "Rejected") return { sent: result as SendResult, delivered: false };
            const sent: SendResult = {
              _tag: "Accepted",
              receipt: {
                stream: `${kit.name}/${id}`,
                version: result.version,
                events: result.events.map((e) => e.event),
                reply: result.reply,
              },
            };
            const state = JSON.stringify(result.state);
            // The events primary key fences a runner that lost the shard
            // and still writes: its insert collides and its transaction rolls back.
            if (row)
              yield* sql`UPDATE ${table.aggregates} SET state = ${state}, version = ${result.version} WHERE name = ${kit.name} AND id = ${id} AND version = ${version}`;
            else
              yield* sql`INSERT INTO ${table.aggregates} ${sql.insert({ name: kit.name, id, state, version: result.version })}`;
            if (result.events.length > 0)
              yield* insertAll(
                table.events,
                result.events.map((e) => ({
                  name: kit.name,
                  id,
                  seq: e.envelope.seq,
                  event: JSON.stringify(e.event),
                  envelope: JSON.stringify(e.envelope),
                  at: e.envelope.at,
                })),
              );
            yield* sql`INSERT INTO ${table.receipts} ${sql.insert({
              name: kit.name,
              id,
              command_id: meta.commandId,
              result: JSON.stringify(sent),
              at,
            })}`;
            yield* stage(keyOf(id), result.deliveries);
            return { sent, delivered: result.deliveries.length > 0 };
          });
        /** After a commit: wake live reads, and forward the deliveries. */
        const committed = (id: string, delivered: boolean) =>
          Effect.andThen(announce(keyOf(id)), delivered ? kick(keyOf(id)) : Effect.void);

        yield* register(
          entity,
          Effect.gen(function* () {
            const id = (yield* Entity.CurrentAddress).entityId;
            return entity.of({
              Send: ({ payload }) =>
                reportDefects(
                  Effect.gen(function* () {
                    const meta = payload.meta as Aggregate.SendMeta;
                    const { sent, delivered } = yield* sql.withTransaction(
                      commit(id, payload.command, meta),
                    );
                    if (sent._tag === "Accepted") yield* committed(id, delivered);
                    return sent as unknown;
                  }).pipe(Effect.orDie),
                ),
              Schedule: ({ payload }) =>
                reportDefects(
                  Effect.gen(function* () {
                    const meta = payload.meta as Aggregate.SendMeta;
                    const outcome = yield* sql.withTransaction(
                      Effect.gen(function* () {
                        if (yield* receiptOf(id, meta.commandId)) return undefined;
                        const token = yield* Effect.sync(() => crypto.randomUUID());
                        const at = yield* now;
                        const row = {
                          token,
                          due: payload.at,
                          command: JSON.stringify(payload.command),
                          meta: JSON.stringify(meta),
                          at,
                        };
                        const found =
                          yield* sql`SELECT token FROM ${table.schedules} WHERE name = ${kit.name} AND id = ${id} AND command_id = ${meta.commandId}`;
                        if (found.length > 0)
                          yield* sql`UPDATE ${table.schedules} SET ${sql.update(row)} WHERE name = ${kit.name} AND id = ${id} AND command_id = ${meta.commandId}`;
                        else
                          yield* sql`INSERT INTO ${table.schedules} ${sql.insert({ name: kit.name, id, command_id: meta.commandId, ...row })}`;
                        return token;
                      }),
                    );
                    if (outcome === undefined) return "AlreadyExecuted" as unknown;
                    // A timer replaced before it fires finds a stale token and does nothing.
                    yield* sendFire(
                      kit.name,
                      id,
                      Fire.make({ commandId: meta.commandId, token: outcome, at: payload.at }),
                    );
                    return { at: payload.at } as unknown;
                  }).pipe(Effect.orDie),
                ),
              Unschedule: ({ payload }) =>
                reportDefects(
                  sql
                    .withTransaction(
                      Effect.gen(function* () {
                        const { commandId } = payload;
                        if (yield* receiptOf(id, commandId)) return "AlreadyExecuted";
                        const rows = yield* sql<{
                          token: string;
                        }>`SELECT token FROM ${table.schedules} WHERE name = ${kit.name} AND id = ${id} AND command_id = ${commandId}`;
                        if (rows.length === 0) return "NotScheduled";
                        if (rows[0]!.token === CANCELLED) return "AlreadyCancelled";
                        const at = yield* now;
                        yield* sql`UPDATE ${table.schedules} SET token = ${CANCELLED}, at = ${at} WHERE name = ${kit.name} AND id = ${id} AND command_id = ${commandId}`;
                        return "Cancelled";
                      }),
                    )
                    .pipe(
                      Effect.map((outcome) => outcome as unknown),
                      Effect.orDie,
                    ),
                ),
              Fire: ({ payload }) =>
                Effect.gen(function* () {
                  const outcome = yield* sql.withTransaction(
                    Effect.gen(function* () {
                      const rows =
                        yield* sql<ScheduleRow>`SELECT token, command, meta FROM ${table.schedules} WHERE name = ${kit.name} AND id = ${id} AND command_id = ${payload.commandId}`;
                      const row = rows[0];
                      // Cancelled, replaced, or already run.
                      if (row === undefined || row.token !== payload.token) return undefined;
                      const result = yield* commit(
                        id,
                        JSON.parse(row.command),
                        JSON.parse(row.meta) as Aggregate.SendMeta,
                      );
                      yield* sql`DELETE FROM ${table.schedules} WHERE name = ${kit.name} AND id = ${id} AND command_id = ${payload.commandId}`;
                      return result;
                    }),
                  );
                  if (outcome?.sent._tag === "Accepted") yield* committed(id, outcome.delivered);
                  if (outcome?.sent._tag === "Rejected")
                    yield* Effect.logWarning(
                      `Domain.Cluster: scheduled ${kit.name}/${id} ${payload.commandId} was rejected`,
                    );
                }).pipe(Effect.orDie),
            });
          }),
        );

        const client = yield* aggregateClient(kit.name);
        return {
          send: (id, command, meta) => call<SendResult>(client(id).Send({ command, meta })),
          schedule: (id, command, meta, due) =>
            Effect.gen(function* () {
              const at = "at" in due ? due.at : (yield* now) + due.afterMillis;
              const outcome = yield* call<{ readonly at: number } | "AlreadyExecuted">(
                client(id).Schedule({ command, meta, at }),
              );
              if (outcome === "AlreadyExecuted")
                return yield* new AlreadyExecuted({
                  aggregate: kit.name,
                  id,
                  commandId: meta.commandId,
                });
              return outcome.at;
            }),
          unschedule: (id, commandId) =>
            call<"Cancelled" | "AlreadyExecuted" | "AlreadyCancelled" | "NotScheduled">(
              client(id).Unschedule({ commandId }),
            ).pipe(
              Effect.flatMap(
                (
                  outcome,
                ): Effect.Effect<void, AlreadyExecuted | AlreadyCancelled | NotScheduled> => {
                  const fields = { aggregate: kit.name, id, commandId };
                  if (outcome === "AlreadyExecuted")
                    return Effect.fail(new AlreadyExecuted(fields));
                  if (outcome === "AlreadyCancelled")
                    return Effect.fail(new AlreadyCancelled(fields));
                  if (outcome === "NotScheduled") return Effect.fail(new NotScheduled(fields));
                  return Effect.void;
                },
              ),
            ),
          state: current,
          events: (id) => eventsAfter(id, 0),
          changes: (id) => watch(keyOf(id), current(id), (s) => s.version),
          tail: (id, after) =>
            follow(
              keyOf(id),
              after,
              (cursor) => eventsAfter(id, cursor),
              (e) => e.envelope.seq,
            ),
        };
      });

    // ------------------------------------------------------------ views

    const view = (_view: unknown, kit: ViewKit) =>
      Effect.gen(function* (): Effect.fn.Return<ViewStore> {
        const type = typeOf("View", kit.name);
        const entity = viewEntity(type);
        const keyOf = (key: string) => `${type}/${key}`;
        const snapshotOf = (key: string) =>
          sql<{
            snapshot: string;
          }>`SELECT snapshot FROM ${table.views} WHERE name = ${kit.name} AND id = ${key}`.pipe(
            Effect.map((rows) =>
              rows[0] ? (JSON.parse(rows[0].snapshot) as ViewSnapshot) : undefined,
            ),
          );
        const read = (key: string) =>
          snapshotOf(key).pipe(
            Effect.map((snapshot) => snapshot ?? emptySnapshot),
            Effect.orDie,
          );
        const entriesAfter = (key: string, after: number) =>
          sql<{
            seq: number | string;
            event: string;
            envelope: string;
            state: string;
          }>`SELECT seq, event, envelope, state FROM ${table.viewEntries} WHERE name = ${kit.name} AND id = ${key} AND seq > ${after} ORDER BY seq`.pipe(
            Effect.map((rows) =>
              rows.map((row): ViewEntry => ({
                seq: Number(row.seq),
                event: JSON.parse(row.event),
                envelope: JSON.parse(row.envelope),
                state: parse(row.state),
              })),
            ),
            Effect.orDie,
          );
        const apply = (key: string, deliveries: ReadonlyArray<Delivery>) =>
          Effect.gen(function* () {
            const before = yield* snapshotOf(key);
            const result = kit.apply(key, before ?? emptySnapshot, deliveries);
            if (!result.changed) return undefined;
            const snapshot = JSON.stringify(result.snapshot);
            if (before)
              yield* sql`UPDATE ${table.views} SET snapshot = ${snapshot} WHERE name = ${kit.name} AND id = ${key}`;
            else
              yield* sql`INSERT INTO ${table.views} ${sql.insert({ name: kit.name, id: key, snapshot })}`;
            if (result.entries.length > 0) {
              yield* insertAll(
                table.viewEntries,
                result.entries.map((entry) => ({
                  name: kit.name,
                  id: key,
                  seq: entry.seq,
                  event: JSON.stringify(entry.event),
                  envelope: JSON.stringify(entry.envelope),
                  state: JSON.stringify(entry.state),
                })),
              );
              if (keep !== "all")
                yield* sql`DELETE FROM ${table.viewEntries} WHERE name = ${kit.name} AND id = ${key} AND seq <= ${result.snapshot.seq - keep}`;
            }
            yield* stage(keyOf(key), result.downstream);
            return result.downstream.length > 0;
          });

        yield* register(
          entity,
          Effect.gen(function* () {
            const key = (yield* Entity.CurrentAddress).entityId;
            return entity.of({
              Deliver: ({ payload }) =>
                Effect.gen(function* () {
                  const deliveries = [payload.delivery as Delivery];
                  const delivered = yield* sql
                    .withTransaction(apply(key, deliveries))
                    .pipe(kit.observe(key, deliveries));
                  if (delivered === undefined) return;
                  yield* announce(keyOf(key));
                  if (delivered) yield* kick(keyOf(key));
                }).pipe(Effect.orDie),
            });
          }),
        );

        const client = yield* clientOf(type, () => entity);
        return {
          receive: (key, deliveries) =>
            Effect.forEach(
              deliveries,
              (delivery) =>
                (
                  client(key).Deliver(Deliver.make({ delivery }), {
                    discard: true,
                  }) as Effect.Effect<void, unknown>
                ).pipe(Effect.retry(TRANSIT_RETRY), Effect.orDie),
              { discard: true },
            ),
          read,
          changes: (key) => watch(keyOf(key), read(key), (s) => s.version),
          list: (key) => entriesAfter(key, 0),
          tail: (key, after) =>
            follow(
              keyOf(key),
              after,
              (cursor) => entriesAfter(key, cursor),
              (e) => e.seq,
            ),
        };
      });

    // ------------------------------------------------------------ policies

    const policy = (_policy: unknown, kit: PolicyKit) =>
      Effect.gen(function* (): Effect.fn.Return<PolicyStore> {
        const type = typeOf("Policy", kit.name);
        const entity = policyEntity(type);
        // At least once: the handler sends commands, so it runs outside a
        // transaction; a crash during a run runs it again.
        yield* register(
          entity,
          Effect.succeed(
            entity.of({
              Deliver: ({ payload }) =>
                kit.run(payload.delivery as Delivery).pipe(
                  Effect.catchDefect((defect) => Effect.fail(defect)),
                  Effect.retry(POLICY_RETRY),
                  Effect.catchCause((cause) => Effect.logError(`policy ${kit.name} failed`, cause)),
                ),
            }),
          ),
        );
        const client = yield* clientOf(type, () => entity);
        return {
          receive: (delivery) =>
            (
              client(delivery.key).Deliver(Deliver.make({ delivery }), {
                discard: true,
              }) as Effect.Effect<void, unknown>
            ).pipe(Effect.retry(TRANSIT_RETRY), Effect.orDie),
        };
      });

    // ------------------------------------------------------------ projections

    const projection = (_projection: unknown, kit: ProjectionKit) =>
      Effect.gen(function* (): Effect.fn.Return<ProjectionStore> {
        const type = typeOf("Projection", kit.name);
        const entity = projectionEntity(type);
        const size = kit.options.batch?.size ?? 1;
        const waitMillis = kit.options.batch?.waitMillis ?? 0;
        const metaOf = (key: string) =>
          sql<{
            accepted: number | string;
            processed: number | string;
            intake: string;
            checkpoints: string;
          }>`SELECT accepted, processed, intake, checkpoints FROM ${table.projections} WHERE name = ${kit.name} AND id = ${key}`.pipe(
            Effect.map((rows) => {
              const row = rows[0];
              if (!row) return undefined;
              return {
                accepted: Number(row.accepted),
                processed: Number(row.processed),
                intake: JSON.parse(row.intake),
                checkpoints: JSON.parse(row.checkpoints),
              } satisfies ProjectionMeta;
            }),
          );
        const putMeta = (key: string, exists: boolean, meta: ProjectionMeta) => {
          const row = {
            accepted: meta.accepted,
            processed: meta.processed,
            intake: JSON.stringify(meta.intake),
            checkpoints: JSON.stringify(meta.checkpoints),
          };
          return exists
            ? sql`UPDATE ${table.projections} SET ${sql.update(row)} WHERE name = ${kit.name} AND id = ${key}`
            : sql`INSERT INTO ${table.projections} ${sql.insert({ name: kit.name, id: key, ...row })}`;
        };
        /** Accept a delivery into the key's input log, dropping one already accepted. */
        const accept = (key: string, delivery: Delivery) =>
          Effect.gen(function* () {
            const found = yield* metaOf(key);
            const meta = found ?? emptyProjectionMeta;
            if ((meta.intake[delivery.source] ?? 0) >= delivery.seq) return;
            const position = meta.accepted + 1;
            yield* sql`INSERT INTO ${table.projectionInputs} ${sql.insert({
              name: kit.name,
              id: key,
              position,
              delivery: JSON.stringify(delivery),
              at: yield* now,
            })}`;
            yield* putMeta(key, found !== undefined, {
              ...meta,
              accepted: position,
              intake: { ...meta.intake, [delivery.source]: delivery.seq },
            });
          });
        const flushAt = (key: string, at: number) =>
          Effect.gen(function* () {
            const client = yield* clientOf(type, () => entity);
            yield* (
              client(key).Flush(Flush.make({ at }), { discard: true }) as Effect.Effect<
                void,
                unknown
              >
            ).pipe(Effect.retry(TRANSIT_RETRY), Effect.orDie);
            yield* wakeAt(at);
          });
        /**
         * Run the key's waiting inputs in order, in batches. A run, its
         * stream writes and the checkpoint commit in one transaction, so a
         * handler that writes through the same SqlClient runs exactly once.
         */
        const process = (key: string) =>
          Effect.gen(function* () {
            while (true) {
              const meta = yield* metaOf(key);
              if (!meta || meta.processed >= meta.accepted) return;
              const rows = yield* sql<{
                position: number | string;
                delivery: string;
                at: number | string;
              }>`SELECT position, delivery, at FROM ${table.projectionInputs} WHERE name = ${kit.name} AND id = ${key} AND position > ${meta.processed} ORDER BY position ${limit(size)}`;
              const run = rows.map((row): Accepted => ({
                position: Number(row.position),
                delivery: JSON.parse(row.delivery),
                at: Number(row.at),
              }));
              if (run.length === 0) return;
              if (run.length < size && waitMillis > 0 && (yield* now) - run[0]!.at < waitMillis) {
                return yield* flushAt(key, run[0]!.at + waitMillis);
              }
              const exit = yield* Effect.exit(
                sql.withTransaction(
                  Effect.gen(function* () {
                    yield* kit.run(key, run);
                    const handled: Record<string, number> = {};
                    for (const { delivery } of run)
                      handled[delivery.source] = Math.max(
                        handled[delivery.source] ?? 0,
                        delivery.seq,
                      );
                    const last = run[run.length - 1]!.position;
                    const fresh = (yield* metaOf(key)) ?? meta;
                    yield* putMeta(key, true, {
                      ...fresh,
                      processed: last,
                      checkpoints: mergeCheckpoints(fresh.checkpoints, handled),
                    });
                    yield* sql`DELETE FROM ${table.projectionInputs} WHERE name = ${kit.name} AND id = ${key} AND position <= ${last}`;
                  }),
                ),
              );
              if (exit._tag === "Failure") {
                yield* Effect.logError(`projection ${kit.name} failed; retrying`, exit.cause);
                return yield* flushAt(key, (yield* now) + PROJECTION_RETRY_MS);
              }
            }
          });

        yield* register(
          entity,
          Effect.gen(function* () {
            const key = (yield* Entity.CurrentAddress).entityId;
            return entity.of({
              Deliver: ({ payload }) =>
                sql
                  .withTransaction(accept(key, payload.delivery as Delivery))
                  .pipe(Effect.andThen(process(key)), Effect.orDie),
              Flush: () => process(key).pipe(Effect.orDie),
            });
          }),
        );

        const client = yield* clientOf(type, () => entity);
        return {
          receive: (delivery) =>
            (
              client(delivery.key).Deliver(Deliver.make({ delivery }), {
                discard: true,
              }) as Effect.Effect<void, unknown>
            ).pipe(Effect.retry(TRANSIT_RETRY), Effect.orDie),
          checkpoints: (key) =>
            metaOf(key).pipe(
              Effect.map((meta) => ({ ...meta?.checkpoints })),
              Effect.orDie,
            ),
        };
      });

    // ------------------------------------------------------------ streams

    const stream = (_stream: unknown, kit: StreamKit) =>
      Effect.sync((): StreamStore => {
        // A stream's only writer is its projection, on that projection's
        // entity, so its writes join the projection run's transaction.
        const keyOf = (key: string) => `${typeOf("Stream", kit.name)}/${key}`;
        const metaOf = (key: string) =>
          sql<{
            meta: string;
          }>`SELECT meta FROM ${table.streams} WHERE name = ${kit.name} AND id = ${key}`.pipe(
            Effect.map((rows) => (rows[0] ? (JSON.parse(rows[0].meta) as StreamMeta) : undefined)),
          );
        const putMeta = (key: string, exists: boolean, meta: StreamMeta) =>
          exists
            ? sql`UPDATE ${table.streams} SET meta = ${JSON.stringify(meta)} WHERE name = ${kit.name} AND id = ${key}`
            : sql`INSERT INTO ${table.streams} ${sql.insert({ name: kit.name, id: key, meta: JSON.stringify(meta) })}`;
        const read = (key: string) =>
          metaOf(key).pipe(
            Effect.map((meta) => meta ?? emptyStreamMeta),
            Effect.orDie,
          );
        const entriesAfter = (key: string, after: number) =>
          sql<{
            seq: number | string;
            event: string;
            envelope: string;
          }>`SELECT seq, event, envelope FROM ${table.streamEntries} WHERE name = ${kit.name} AND id = ${key} AND seq > ${after} ORDER BY seq`.pipe(
            Effect.map((rows) =>
              rows.map((row): StreamEntry => ({
                seq: Number(row.seq),
                event: JSON.parse(row.event),
                envelope: JSON.parse(row.envelope),
              })),
            ),
            Effect.orDie,
          );
        const changed = (key: string) => sql.afterCommit(announce(keyOf(key)));
        return {
          append: (key: string, write: StreamWrite) =>
            sql
              .withTransaction(
                Effect.gen(function* () {
                  const found = yield* metaOf(key);
                  const meta = found ?? emptyStreamMeta;
                  if (!isAfter(write.origin, meta.origin)) return;
                  const added = write.events.map((event, index): StreamEntry => {
                    const seq = meta.seq + index + 1;
                    return {
                      seq,
                      event,
                      envelope: {
                        id: key,
                        stream: `${kit.name}/${key}`,
                        seq,
                        at: write.at,
                        commandId: write.commandId,
                      },
                    };
                  });
                  if (added.length > 0)
                    yield* insertAll(
                      table.streamEntries,
                      added.map((entry) => ({
                        name: kit.name,
                        id: key,
                        seq: entry.seq,
                        event: JSON.stringify(entry.event),
                        envelope: JSON.stringify(entry.envelope),
                      })),
                    );
                  yield* putMeta(key, found !== undefined, {
                    seq: meta.seq + added.length,
                    origin: write.origin,
                    checkpoints: mergeCheckpoints(meta.checkpoints, {
                      [write.source]: write.sourceSeq,
                    }),
                  });
                  yield* changed(key);
                }),
              )
              .pipe(Effect.orDie),
          advance: (key: string, checkpoints: Readonly<Record<string, number>>) =>
            sql
              .withTransaction(
                Effect.gen(function* () {
                  const found = yield* metaOf(key);
                  const meta = found ?? emptyStreamMeta;
                  yield* putMeta(key, found !== undefined, {
                    ...meta,
                    checkpoints: mergeCheckpoints(meta.checkpoints, checkpoints),
                  });
                  yield* changed(key);
                }),
              )
              .pipe(Effect.orDie),
          read,
          // Every change of the meta, `advance` included (it moves only the checkpoints).
          changes: (key: string) => watch(keyOf(key), read(key), (meta) => JSON.stringify(meta)),
          list: (key: string) => entriesAfter(key, 0),
          tail: (key: string, after: number) =>
            follow(
              keyOf(key),
              after,
              (cursor) => entriesAfter(key, cursor),
              (e) => e.seq,
            ),
        };
      });

    return Platform.of({ aggregate, view, policy, projection, stream });
  });

/**
 * Host a domain model on `effect/cluster`, with its data in any
 * `effect/sql` database: SQLite, Postgres, MySQL or MariaDB. Every aggregate
 * instance, view key, policy key and projection key is a cluster entity, so
 * each runs one message at a time on the runner that owns its shard. Sagas
 * run on `ClusterWorkflowEngine`.
 *
 * A command's events, state, receipt and outbox rows commit in one SQL
 * transaction. Deliveries to views, policies and projections are persisted
 * cluster messages, sent after the commit, at least once and in order per
 * source; scheduled commands are persisted messages with a due time. Reads
 * are plain SQL from any runner.
 *
 * It needs the cluster (`Sharding` and `MessageStorage`) and a `SqlClient`.
 * For one process, use {@link layerSingleRunner}, which brings the cluster.
 *
 * ### Hosting on several runners
 * **Example:** Runners on one Postgres database
 * ```typescript
 * import * as Cluster from "@alchemy.run/domain/Cluster";
 * import { BunClusterSocket } from "@effect/platform-bun";
 * import { PgClient } from "@effect/sql-pg";
 * import * as Config from "effect/Config";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankPolicies } from "./Bank.ts";
 *
 * export const BankLive = Bank.layer(BankPolicies).pipe(
 *   Layer.provide(Cluster.layer()),
 *   Layer.provide(BunClusterSocket.layer()),
 *   Layer.provide(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })),
 * );
 * ```
 *
 * @layer
 * @provides Domain.Platform
 * @provides WorkflowEngine
 */
export const layer = (
  options: Options = {},
): Layer.Layer<
  Platform | WorkflowEngine.WorkflowEngine,
  never,
  Sharding.Sharding | MessageStorage.MessageStorage | SqlClient.SqlClient
> => {
  // The same options return the same Layer, so models that each provide it
  // share one platform: the sweeper is one singleton per table prefix.
  const key = JSON.stringify(options);
  let found = layers.get(key);
  if (found === undefined)
    layers.set(
      key,
      (found = Layer.merge(Layer.effect(Platform, make(options)), ClusterWorkflowEngine.layer)),
    );
  return found;
};

const layers = new Map<
  string,
  Layer.Layer<
    Platform | WorkflowEngine.WorkflowEngine,
    never,
    Sharding.Sharding | MessageStorage.MessageStorage | SqlClient.SqlClient
  >
>();

/**
 * Host a domain model in one process on `effect/cluster`: {@link layer}
 * with a single runner that owns every shard. Give it a `SqlClient`; the
 * cluster keeps its messages in the same database.
 *
 * With `runnerStorage: "sql"` (the default) the runner locks its shards in
 * the database, so a second process waits until the first one stops. Use
 * `runnerStorage: "memory"` for SQLite and tests.
 *
 * The cluster reads its configuration from the environment
 * (`ShardingConfig.layerFromEnv`, which reads `HOST`, `PORT` and other
 * constant-case names): a `PORT` that is not an integer fails the Layer.
 *
 * ### Hosting in one process
 * **Example:** A model on MySQL or MariaDB
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import { MysqlClient } from "@effect/sql-mysql2";
 * import * as Config from "effect/Config";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankPolicies } from "./Bank.ts";
 *
 * export const BankLive = Bank.layer(BankPolicies).pipe(
 *   Layer.provide(Domain.Cluster.layerSingleRunner()),
 *   Layer.provide(MysqlClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })),
 * );
 * ```
 *
 * **Example:** Tests on SQLite in memory
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import { SqliteClient } from "@effect/sql-sqlite-bun";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankPolicies } from "./Bank.ts";
 *
 * export const BankOnSqlite = Bank.layer(BankPolicies).pipe(
 *   Layer.provide(Domain.Cluster.layerSingleRunner({ runnerStorage: "memory" })),
 *   Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
 * );
 * ```
 *
 * @layer
 * @provides Domain.Platform
 * @provides WorkflowEngine
 */
export const layerSingleRunner = ({
  shardingConfig,
  runnerStorage,
  ...options
}: SingleRunnerOptions = {}): Layer.Layer<
  Platform | WorkflowEngine.WorkflowEngine,
  ConfigError,
  SqlClient.SqlClient
> =>
  layer(options).pipe(
    Layer.provide(
      SingleRunner.layer({
        shardingConfig: { entityMessagePollInterval: "1 second", ...shardingConfig },
        runnerStorage,
      }),
    ),
    Layer.provide(Digest.layerWebCrypto),
  );
