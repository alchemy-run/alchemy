/**
 * The cluster host on SQL servers. Each suite runs only when its database
 * URL is set:
 *
 *   DOMAIN_TEST_POSTGRES_URL=postgres://user@localhost/domain_cluster_test
 *   DOMAIN_TEST_MYSQL_URL=mysql://user@localhost/domain_cluster_test
 *
 * Every test uses its own table prefixes, and drops its tables before and
 * after it runs.
 */
import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as BunClusterSocket from "@effect/platform-bun/BunClusterSocket";
import { MysqlClient } from "@effect/sql-mysql2";
import { PgClient } from "@effect/sql-pg";
import * as RunnerAddress from "effect/cluster/RunnerAddress";
import * as RunnerHealth from "effect/cluster/RunnerHealth";
import * as Runners from "effect/cluster/Runners";
import * as RunnerStorage from "effect/cluster/RunnerStorage";
import * as Sharding from "effect/cluster/Sharding";
import * as ShardingConfig from "effect/cluster/ShardingConfig";
import * as SqlMessageStorage from "effect/cluster/SqlMessageStorage";
import * as SqlRunnerStorage from "effect/cluster/SqlRunnerStorage";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import {
  ContractApi,
  Counter,
  eventually,
  hostContract,
  hosted,
  Increment,
} from "./fixtures/HostContract.ts";

const POSTGRES_URL = process.env.DOMAIN_TEST_POSTGRES_URL;
const MYSQL_URL = process.env.DOMAIN_TEST_MYSQL_URL;

type SqlLayer = Layer.Layer<SqlClient.SqlClient, unknown>;

/** The tables one test owns: the host's and the cluster's. */
const tablesOf = (prefix: string) => [
  ...[
    "aggregates",
    "events",
    "receipts",
    "schedules",
    "outbox",
    "views",
    "view_entries",
    "projections",
    "projection_inputs",
    "streams",
    "stream_entries",
    "migrations",
  ].map((table) => `${prefix}_${table}`),
  ...["replies", "messages", "migrations", "locks", "runners", "runner_migrations"].map(
    (table) => `${prefix}c_${table}`,
  ),
];

/** Drop a test's tables when it starts (a run that crashed left them) and when it ends. */
const clean = (prefix: string): Layer.Layer<never, never, SqlClient.SqlClient> => {
  const drop = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const table of tablesOf(prefix)) yield* sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
  }).pipe(Effect.orDie);
  return Layer.effectDiscard(Effect.acquireRelease(drop, () => drop));
};

const config = { entityMessagePollInterval: "1 second" } as const;

/** One runner that owns every shard, with its own table prefixes. */
const singleRunner = (prefix: string) =>
  Domain.Cluster.layer({ tablePrefix: prefix, clusterTablePrefix: `${prefix}c` }).pipe(
    Layer.provide(
      Sharding.layer.pipe(
        Layer.provideMerge(Runners.layerNoop),
        Layer.provideMerge(
          SqlMessageStorage.layerStorage({ prefix: `${prefix}c` }).pipe(
            Layer.provide(SqlMessageStorage.layerMigrations({ prefix: `${prefix}c` })),
          ),
        ),
        Layer.provide([RunnerStorage.layerMemory, RunnerHealth.layerNoop]),
        Layer.provide(ShardingConfig.layer(config)),
        Layer.provide(Digest.layerWebCrypto),
      ),
    ),
  );

/** A socket runner on `port`, sharing the database with the others; the tables come from a deploy step. */
const socketRunner = (prefix: string, port: number) => {
  const shardingConfig = {
    ...config,
    runnerAddress: Option.some(RunnerAddress.make("localhost", port)),
  };
  return Domain.Cluster.layer({
    tablePrefix: prefix,
    clusterTablePrefix: `${prefix}c`,
    migrations: false,
  }).pipe(
    Layer.provide(BunClusterSocket.layer({ storage: "byo", shardingConfig })),
    Layer.provide(
      Layer.mergeAll(
        SqlMessageStorage.layerStorage({ prefix: `${prefix}c` }),
        SqlRunnerStorage.layerStorage({ prefix: `${prefix}c` }),
      ),
    ),
    Layer.provide(ShardingConfig.layer(shardingConfig)),
    Layer.provide(Digest.layerWebCrypto),
  );
};

/** The deploy step: every table, made once before the runners start. */
const migrate = (prefix: string) =>
  Layer.mergeAll(
    Domain.Cluster.layerMigrations({ tablePrefix: prefix }),
    SqlMessageStorage.layerMigrations({ prefix: `${prefix}c` }),
    SqlRunnerStorage.layerMigrations({ prefix: `${prefix}c` }),
  );

const suite = (
  name: string,
  url: string | undefined,
  client: (url: string) => SqlLayer,
  ports: readonly [number, number],
) =>
  describe.skipIf(url === undefined)(`Domain.Cluster on ${name}`, () => {
    const tag = name.toLowerCase();
    let next = 0;
    // MySQL and MariaDB: a deadlock must not leave a stored reply without the
    // writes it reports (https://github.com/Effect-TS/effect/issues/10162).
    const stress = `dct_${tag}_stress`;
    /** A host on new tables, with one runner and its own connection pool. */
    const onPrefix = (prefix: string) =>
      singleRunner(prefix).pipe(Layer.provide(clean(prefix)), Layer.provideMerge(client(url!)));

    hostContract(`Cluster on ${name}`, () => onPrefix(`dct_${tag}_${next++}`));

    it.live(
      "concurrent commands and deliveries leave no reply without its writes",
      () =>
        Effect.gen(function* () {
          const prefix = stress;
          const counters = yield* Counter;
          const api = yield* ContractApi.Client;
          const sql = yield* SqlClient.SqlClient;
          const ids = ["s-1", "s-2", "s-3", "s-4"];
          // 16 fibers, 160 commands, 4 instances: each command commits an
          // event, a receipt and outbox rows while views, the policy and the
          // projection write their own rows and the cluster's.
          yield* Effect.forEach(
            Array.from({ length: 160 }, (_, i) => i),
            (i) => counters.send(ids[i % 4]!, new Increment({ by: 1 }), { commandId: `cmd-${i}` }),
            { concurrency: 16, discard: true },
          );
          for (const id of ids) {
            expect(yield* counters.state(id)).toEqual({ total: 40 });
            yield* api.Totals.get(id, { atLeast: { stream: `Counter/${id}`, version: 40 } });
            yield* eventually(
              counters.state(`mirror-${id}`).pipe(
                Effect.filterOrFail(
                  (s) => s.total === 40,
                  () => "not yet" as const,
                ),
              ),
              30,
            );
          }
          for (const id of ids) {
            const [row] = yield* sql<{
              version: number;
            }>`SELECT version FROM ${sql(`${prefix}_aggregates`)} WHERE name = 'Counter' AND id = ${id}`;
            const events = yield* sql<{
              seq: number;
            }>`SELECT seq FROM ${sql(`${prefix}_events`)} WHERE name = 'Counter' AND id = ${id} ORDER BY seq`;
            const receipts = yield* sql<{
              n: number;
            }>`SELECT COUNT(*) AS n FROM ${sql(`${prefix}_receipts`)} WHERE name = 'Counter' AND id = ${id}`;
            // Every receipt has its events and its state: gapless, one per command.
            expect(Number(row!.version)).toBe(40);
            expect(events.map((event) => Number(event.seq))).toEqual(
              Array.from({ length: 40 }, (_, i) => i + 1),
            );
            expect(Number(receipts[0]!.n)).toBe(40);
          }
          // Every delivery the cluster marked processed (its reply is stored)
          // is in the view's state.
          const processed = yield* sql<{
            entity_id: string;
            payload: string;
          }>`SELECT entity_id, payload FROM ${sql(`${prefix}c_messages`)} WHERE entity_type = ${`Domain.View/${prefix}/Totals`} AND processed = ${sql.literal(tag === "postgres" ? "TRUE" : "1")}`;
          expect(processed.length).toBeGreaterThan(0);
          for (const message of processed) {
            const { delivery } = JSON.parse(message.payload) as {
              delivery: { source: string; seq: number };
            };
            const [view] = yield* sql<{
              snapshot: string;
            }>`SELECT snapshot FROM ${sql(`${prefix}_views`)} WHERE name = 'Totals' AND id = ${message.entity_id}`;
            const snapshot = JSON.parse(view!.snapshot) as { checkpoints: Record<string, number> };
            expect(snapshot.checkpoints[delivery.source]!).toBeGreaterThanOrEqual(delivery.seq);
          }
        }).pipe(Effect.scoped, Effect.provide(hosted(onPrefix(stress)))),
      { timeout: 120_000 },
    );

    it.live(
      "two runners share one database; one stops and the other takes over its work",
      () =>
        Effect.gen(function* () {
          const prefix = `dct_${tag}_runners`;
          yield* Layer.build(
            migrate(prefix).pipe(Layer.provide(clean(prefix)), Layer.provide(client(url!))),
          );
          const start = (port: number) =>
            Effect.gen(function* () {
              const scope = yield* Scope.make();
              // Stopped before the tables are dropped, even when the test fails.
              yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
              const context = yield* Layer.buildWithScope(
                hosted(socketRunner(prefix, port).pipe(Layer.provideMerge(client(url!)))),
                scope,
              );
              return { scope, context };
            });
          const a = yield* start(ports[0]);
          const b = yield* start(ports[1]);
          const ids = Array.from({ length: 20 }, (_, i) => `r-${i}`);
          const sendAll = (runner: typeof a, round: number) =>
            Effect.forEach(
              ids,
              (id) =>
                Effect.gen(function* () {
                  const counters = yield* Counter;
                  yield* counters.send(id, new Increment({ by: 1 }), {
                    commandId: `${id}-${round}`,
                  });
                }).pipe(Effect.provide(runner.context)),
              { concurrency: "unbounded", discard: true },
            );

          // Both runners answer for every instance, wherever its shard is.
          yield* sendAll(a, 1);
          yield* sendAll(b, 2);

          // B stops; A takes its shards and its work.
          const stopping = yield* Effect.sync(() => Date.now());
          yield* Scope.close(b.scope, Exit.void);
          const stopped = yield* Effect.sync(() => Date.now());
          yield* sendAll(a, 3);
          const answered = yield* Effect.sync(() => Date.now());
          yield* Effect.log(
            `Domain.Cluster on ${name}: runner stop ${stopped - stopping} ms, then 20 commands answered in ${answered - stopped} ms`,
          );
          yield* Effect.gen(function* () {
            const counters = yield* Counter;
            const api = yield* ContractApi.Client;
            for (const id of ids) {
              expect(yield* counters.state(id)).toEqual({ total: 3 });
              yield* eventually(
                api.Totals.get(id).pipe(
                  Effect.filterOrFail(
                    (view) => view?.total === 3,
                    () => "not yet" as const,
                  ),
                ),
                60,
              );
            }
          }).pipe(Effect.provide(a.context));
        }).pipe(Effect.scoped),
      { timeout: 120_000 },
    );
  });

suite(
  "Postgres",
  POSTGRES_URL,
  (url) => PgClient.layer({ url: Redacted.make(url), maxConnections: 4 }),
  [34431, 34432],
);
suite(
  "MySQL",
  MYSQL_URL,
  (url) => MysqlClient.layer({ url: Redacted.make(url), maxConnections: 4 }),
  [34433, 34434],
);
