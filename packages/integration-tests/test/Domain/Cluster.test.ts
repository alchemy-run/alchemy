import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as BunClusterSocket from "@effect/platform-bun/BunClusterSocket";
import * as BunServices from "@effect/platform-bun/BunServices";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import * as RunnerAddress from "effect/cluster/RunnerAddress";
import * as ShardingConfig from "effect/cluster/ShardingConfig";
import * as SqlMessageStorage from "effect/cluster/SqlMessageStorage";
import * as SqlRunnerStorage from "effect/cluster/SqlRunnerStorage";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import {
  ContractApi,
  Counter,
  eventually,
  ExpireHold,
  Hold,
  hostContract,
  hosted,
  Increment,
} from "./fixtures/HostContract.ts";
import { concurrentCompletion, rollbackBetweenDeletes } from "./fixtures/RetentionRace.ts";

/** A fresh in-memory SQLite database with the cluster host on it. */
const onSqlite = (options: Domain.Cluster.SingleRunnerOptions = {}) =>
  Domain.Cluster.layerSingleRunner({ runnerStorage: "memory", ...options }).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  );

hostContract("InMemory", () => InMemory);
hostContract("Cluster on SQLite", () => onSqlite());

describe("Domain.Cluster on SQLite", () => {
  it.live("keeps the newest view entries of a key, and events still end their history", () =>
    Effect.gen(function* () {
      const api = yield* ContractApi.Client;
      for (const by of [1, 2, 3, 4, 5]) yield* api.Increment("c-1", { by });
      yield* api.Totals.get("c-1", { atLeast: { stream: "Counter/c-1", version: 5 } });
      const listed = yield* api.Totals.list("c-1");
      expect(listed.entries.map((entry) => entry.envelope.seq)).toEqual([3, 4, 5]);
      const feed = yield* api.Totals.events("c-1").pipe(Stream.take(4), Stream.runCollect);
      expect(
        feed.map((item) =>
          Domain.Read.isCaughtUp(item) ? `caught up at ${item.cursor}` : item.envelope.seq,
        ),
      ).toEqual([3, 4, 5, "caught up at 5"]);
    }).pipe(Effect.scoped, Effect.provide(hosted(onSqlite({ viewEntries: 3 })))),
  );

  it.live("one transaction per command: state, events, receipt; deliveries leave the outbox", () =>
    Effect.gen(function* () {
      const counters = yield* Counter;
      const sql = yield* SqlClient.SqlClient;
      yield* counters.send("c-1", new Increment({ by: 1 }), { commandId: "a" });
      yield* counters.send("c-1", new Increment({ by: 2 }), { commandId: "b" });
      const [row] = yield* sql<{
        version: number;
      }>`SELECT version FROM domain_aggregates WHERE name = 'Counter' AND id = 'c-1'`;
      expect(row!.version).toBe(2);
      const events = yield* sql<{
        seq: number;
      }>`SELECT seq FROM domain_events WHERE name = 'Counter' AND id = 'c-1' ORDER BY seq`;
      expect(events.map((event) => event.seq)).toEqual([1, 2]);
      const receipts = yield* sql<{
        command_id: string;
      }>`SELECT command_id FROM domain_receipts WHERE name = 'Counter' AND id = 'c-1' ORDER BY command_id`;
      expect(receipts.map((receipt) => receipt.command_id)).toEqual(["a", "b"]);
      yield* eventually(
        sql<{ n: number }>`SELECT COUNT(*) AS n FROM domain_outbox`.pipe(
          Effect.filterOrFail(
            ([count]) => Number(count!.n) === 0,
            () => "not yet" as const,
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(hosted(onSqlite()))),
  );

  it.live(
    "a live read on the runner that commits sees the commit without waiting for the poll",
    () =>
      Effect.gen(function* () {
        const api = yield* ContractApi.Client;
        yield* api.Increment("c-1", { by: 1 });
        const seen = yield* Queue.unbounded<{ readonly cursor: number }>();
        yield* api.Counter.watch("c-1").pipe(
          Stream.runForEach((item) => Queue.offer(seen, item)),
          Effect.forkChild,
        );
        expect((yield* Queue.take(seen)).cursor).toBe(1);
        yield* api.Increment("c-1", { by: 2 });
        // The poll runs once a minute here: only the in-process signal arrives this soon.
        const second = yield* Queue.take(seen).pipe(Effect.timeout("10 seconds"));
        expect(second.cursor).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(hosted(onSqlite({ watchMillis: 60_000 })))),
  );

  it.live("accepts every Duration.Input, bigint nanoseconds included", () =>
    Effect.gen(function* () {
      const counters = yield* Counter;
      yield* counters.send("c-1", new Increment({ by: 1 }));
      expect(yield* counters.state("c-1")).toEqual({ total: 1 });
      // Options that mean the same share one Layer.
      expect(Domain.Cluster.layer({ entityMaxIdleTime: "1 second" })).toBe(
        Domain.Cluster.layer({ entityMaxIdleTime: 1_000_000_000n }),
      );
      expect(Domain.Cluster.layer({ entityMaxIdleTime: "1 second" })).not.toBe(
        Domain.Cluster.layer({ entityMaxIdleTime: "2 seconds" }),
      );
    }).pipe(Effect.scoped, Effect.provide(hosted(onSqlite({ entityMaxIdleTime: 1_000_000_000n })))),
  );

  it.live("the documented several-runner composition builds and serves a command", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "domain-cluster-byo-" });
      const Sqlite = SqliteClient.layer({ filename: path.join(dir, "domain.db") });
      // The deploy step from the docs.
      yield* Layer.build(
        Layer.mergeAll(
          Domain.Cluster.layerMigrations(),
          SqlMessageStorage.layerMigrations({}),
          SqlRunnerStorage.layerMigrations({}),
        ).pipe(Layer.provide(Sqlite)),
      );
      // The runner from the docs; only the address differs, for the test.
      const shardingConfig: Partial<ShardingConfig.ShardingConfig["Service"]> = {
        runnerAddress: Option.some(RunnerAddress.make("localhost", 34_421)),
      };
      const ClusterLive = BunClusterSocket.layer({ storage: "byo", shardingConfig }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(SqlMessageStorage.layerStorage({}), SqlRunnerStorage.layerStorage({})),
        ),
        Layer.provide(
          Layer.mergeAll(ShardingConfig.layerFromEnv(shardingConfig), Digest.layerWebCrypto),
        ),
      );
      yield* Effect.gen(function* () {
        const counters = yield* Counter;
        yield* counters.send("c-1", new Increment({ by: 1 }));
        expect(yield* counters.state("c-1")).toEqual({ total: 1 });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          hosted(
            Domain.Cluster.layer({ migrations: false }).pipe(
              Layer.provide(ClusterLive),
              Layer.provideMerge(Sqlite),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live(
    "a timer stored without its message (a crash in between) fires when the sweep starts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "domain-cluster-timer-" });
        const file = path.join(dir, "domain.db");
        const host = () =>
          hosted(
            Domain.Cluster.layerSingleRunner({ runnerStorage: "memory" }).pipe(
              Layer.provideMerge(SqliteClient.layer({ filename: file })),
            ),
          );
        yield* Effect.gen(function* () {
          const holds = yield* Hold;
          yield* holds.schedule("h-1", new ExpireHold(), { after: "1 hour", commandId: "x" });
        }).pipe(Effect.scoped, Effect.provide(host()));
        // What a crash between the schedule's commit and its message leaves: the
        // row, due soon, and no message.
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE domain_schedules SET due = ${Date.now() + 1_500}`;
          yield* sql`DELETE FROM cluster_messages WHERE tag = 'Fire'`;
        }).pipe(Effect.provide(SqliteClient.layer({ filename: file })));
        yield* Effect.gen(function* () {
          const holds = yield* Hold;
          yield* eventually(
            holds.state("h-1").pipe(
              Effect.filterOrFail(
                (s) => s.status === "expired",
                () => "not yet" as const,
              ),
            ),
            5,
          );
        }).pipe(Effect.scoped, Effect.provide(host()));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live(
    "the sweeper deletes receipts, cancelled timers and processed messages past retention",
    () =>
      Effect.gen(function* () {
        const api = yield* ContractApi.Client;
        const counters = yield* Counter;
        const holds = yield* Hold;
        const sql = yield* SqlClient.SqlClient;
        const count = (query: Effect.Effect<ReadonlyArray<{ readonly n: number }>, unknown>) =>
          Effect.map(query, ([row]) => Number(row!.n));
        yield* counters.send("c-1", new Increment({ by: 1 }), { commandId: "a" });
        yield* api.Totals.get("c-1", { atLeast: { stream: "Counter/c-1", version: 1 } });
        yield* holds.schedule("h-1", new ExpireHold(), { after: "1 hour", commandId: "x" });
        yield* holds.unschedule("h-1", "x");
        yield* eventually(
          Effect.all([
            count(sql`SELECT COUNT(*) AS n FROM domain_receipts`),
            count(sql`SELECT COUNT(*) AS n FROM domain_schedules`),
            count(
              sql`SELECT COUNT(*) AS n FROM cluster_messages WHERE entity_type LIKE 'Domain.%' AND processed = 1`,
            ),
          ]).pipe(
            Effect.filterOrFail(
              (counts) => counts.every((n) => n === 0),
              () => "not yet" as const,
            ),
          ),
        );
        // Past retention, a cancel is forgotten and a command id is decided again.
        expect((yield* Effect.flip(holds.unschedule("h-1", "x")))._tag).toBe("NotScheduled");
        const again = yield* counters.send("c-1", new Increment({ by: 1 }), { commandId: "a" });
        expect(again.version).toBe(2);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          hosted(
            onSqlite({
              sweep: { intervalMillis: 100, afterMillis: 30_000 },
              retention: { receipts: 0, cancelled: 0, messages: 0 },
            }),
          ),
        ),
      ),
  );

  it.live("retention prunes only the messages of its own model, and takes bigint durations", () =>
    Effect.gen(function* () {
      const api = yield* ContractApi.Client;
      const sql = yield* SqlClient.SqlClient;
      // Processed messages of two other models on the same cluster: one on
      // another prefix, one on the default prefix.
      for (const [id, type] of [
        [1, "Domain.Policy/rb/Mirror"],
        [2, "Domain.View/Totals"],
      ] as const) {
        yield* sql`INSERT INTO cluster_messages (id, shard_id, entity_type, entity_id, kind, processed, request_id) VALUES (${id}, 'default:1', ${type}, 'k', 0, 1, ${id})`;
        yield* sql`INSERT INTO cluster_replies (id, kind, request_id, payload) VALUES (${id}, 0, ${id}, '{}')`;
      }
      yield* api.Increment("c-1", { by: 1 });
      yield* api.Totals.get("c-1", { atLeast: { stream: "Counter/c-1", version: 1 } });
      const count = (where: string) =>
        sql<{
          n: number;
        }>`SELECT COUNT(*) AS n FROM cluster_messages WHERE processed = 1 AND entity_type LIKE ${where}`.pipe(
          Effect.map(([row]) => Number(row!.n)),
        );
      // This model's processed messages go; the others' stay, with their replies.
      yield* eventually(
        count("Domain.%/ra/%").pipe(
          Effect.filterOrFail(
            (n) => n === 0,
            () => "not yet" as const,
          ),
        ),
      );
      expect(yield* count("Domain.Policy/rb/%")).toBe(1);
      expect(yield* count("Domain.View/Totals")).toBe(1);
      const [replies] = yield* sql<{
        n: number;
      }>`SELECT COUNT(*) AS n FROM cluster_replies WHERE request_id IN (1, 2)`;
      expect(Number(replies!.n)).toBe(2);
      // Options that mean the same share one Layer, whatever form the durations take.
      expect(Domain.Cluster.layer({ retention: { receipts: "1 hour", messages: "forever" } })).toBe(
        Domain.Cluster.layer({ retention: { receipts: 3_600_000_000_000n, messages: "forever" } }),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        hosted(
          onSqlite({
            tablePrefix: "ra",
            sweep: { intervalMillis: 100, afterMillis: 30_000 },
            retention: { receipts: 3_600_000_000_000n, cancelled: 1_000_000_000n, messages: 0n },
          }),
        ),
      ),
    ),
  );

  for (const [title, race] of [
    [
      "retention: a request that completes during a sweep keeps its message and reply",
      concurrentCompletion,
    ],
    ["retention: a failed message delete rolls back its reply delete", rollbackBetweenDeletes],
  ] as const) {
    it.live(title, () =>
      race(
        { messages: "cluster_messages", replies: "cluster_replies", name: "retention_probe" },
        "Domain.Policy/Mirror",
      ).pipe(
        Effect.scoped,
        Effect.provide(
          hosted(
            onSqlite({
              sweep: { intervalMillis: 100, afterMillis: 30_000 },
              retention: { receipts: "forever", cancelled: "forever", messages: 0 },
            }),
          ),
        ),
      ),
    );
  }

  it.live("state, pending deliveries and timers survive a restart on the same file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "domain-cluster-" });
      const host = () =>
        hosted(
          Domain.Cluster.layerSingleRunner({ runnerStorage: "memory" }).pipe(
            Layer.provideMerge(SqliteClient.layer({ filename: path.join(dir, "domain.db") })),
          ),
        );

      // First process: commit, arm a timer, and stop before the timer is due.
      yield* Effect.gen(function* () {
        const counters = yield* Counter;
        const holds = yield* Hold;
        for (const by of [1, 2, 3]) yield* counters.send("c-1", new Increment({ by }));
        yield* holds.schedule("h-1", new ExpireHold(), { after: "1500 millis", commandId: "x" });
      }).pipe(Effect.scoped, Effect.provide(host()));

      // Second process: the same answers, the view catches up, the timer fires.
      yield* Effect.gen(function* () {
        const api = yield* ContractApi.Client;
        const counters = yield* Counter;
        const holds = yield* Hold;
        expect(yield* counters.state("c-1")).toEqual({ total: 6 });
        const total = yield* api.Totals.get("c-1", {
          atLeast: { stream: "Counter/c-1", version: 3 },
        });
        expect(total).toEqual({ total: 6 });
        yield* eventually(
          holds.state("h-1").pipe(
            Effect.filterOrFail(
              (s) => s.status === "expired",
              () => "not yet" as const,
            ),
          ),
        );
        yield* eventually(
          counters.state("mirror-c-1").pipe(
            Effect.filterOrFail(
              (s) => s.total === 6,
              () => "not yet" as const,
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(host()));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
