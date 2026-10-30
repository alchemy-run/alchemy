/**
 * Runner compositions for the SQL suites, shared with the child process that
 * a test kills (`cluster-runner.ts`). No test imports.
 */
import * as Domain from "@alchemy.run/domain";
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";

/** A small pool for a `postgres://` or `mysql://` URL. Each call is a new pool (its own sessions and locks). */
export const sqlClient = (url: string): Layer.Layer<SqlClient.SqlClient, unknown> =>
  url.startsWith("mysql")
    ? MysqlClient.layer({ url: Redacted.make(url), maxConnections: 4 })
    : PgClient.layer({ url: Redacted.make(url), maxConnections: 4 });

export type SqlLayer = Layer.Layer<SqlClient.SqlClient, unknown>;

/** The tables one test owns: the host's and the cluster's. */
export const tablesOf = (prefix: string) => [
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
export const clean = (prefix: string): Layer.Layer<never, never, SqlClient.SqlClient> => {
  const drop = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const table of tablesOf(prefix)) yield* sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
  }).pipe(Effect.orDie);
  return Layer.effectDiscard(Effect.acquireRelease(drop, () => drop));
};

export const config = { entityMessagePollInterval: "1 second" } as const;

/** One runner that owns every shard, with its own table prefixes. */
export const singleRunner = (prefix: string, options: Domain.Cluster.Options = {}) =>
  Domain.Cluster.layer({ ...options, tablePrefix: prefix, clusterTablePrefix: `${prefix}c` }).pipe(
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
export const socketRunner = (prefix: string, port: number) => {
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
export const migrate = (prefix: string) =>
  Layer.mergeAll(
    Domain.Cluster.layerMigrations({ tablePrefix: prefix }),
    SqlMessageStorage.layerMigrations({ prefix: `${prefix}c` }),
    SqlRunnerStorage.layerMigrations({ prefix: `${prefix}c` }),
  );
