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
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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
        const watched = yield* api.Counter.watch("c-1").pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.sleep("100 millis");
        const committed = yield* Effect.sync(() => Date.now());
        yield* api.Increment("c-1", { by: 2 });
        const [, second] = yield* Fiber.join(watched).pipe(Effect.timeout("2 seconds"));
        expect(second!.cursor).toBe(2);
        // The poll runs once a minute here: only the in-process signal is this fast.
        expect((yield* Effect.sync(() => Date.now())) - committed).toBeLessThan(1_000);
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
