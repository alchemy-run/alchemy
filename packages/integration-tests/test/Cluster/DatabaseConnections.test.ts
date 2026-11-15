import { makeStoragePools } from "@alchemy.run/domain/EffectCluster";
/**
 * How many connections a runner holds to the cluster's database: a pool's
 * `databaseConnections` reaches every runner it starts, and sizes both of the
 * runner's pools (the cluster's own, and a Domain model's storage). Every
 * Domain model a runner hosts keeps its objects in one storage pool.
 */
import {
  DATABASE_MAX_CONNECTIONS,
  databaseMaxConnections,
} from "@alchemy.run/effect-cluster/Database";
import { settingsEnvironment } from "@alchemy.run/effect-cluster/internal/PoolHost";
import { describe, expect, it } from "@alchemy.run/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { SqlClient } from "effect/sql/SqlClient";

const withEnv = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

describe("Effect Cluster database connections", { tags: ["unit"] }, () => {
  it("a pool's databaseConnections is set on every runner it starts", () => {
    expect(settingsEnvironment({ databaseConnections: 3 })).toEqual({
      [DATABASE_MAX_CONNECTIONS]: "3",
    });
    expect(settingsEnvironment({})).toEqual({});
  });

  it.effect("a runner sizes its pools from it, or leaves the client's default", () =>
    Effect.gen(function* () {
      expect(
        yield* databaseMaxConnections.pipe(
          withEnv(settingsEnvironment({ databaseConnections: 3 })),
        ),
      ).toBe(3);
      expect(yield* databaseMaxConnections.pipe(withEnv({}))).toBeUndefined();
    }),
  );

  it.effect("every model a runner hosts shares one storage pool per database", () =>
    Effect.gen(function* () {
      const opened: Array<string> = [];
      const pool = makeStoragePools((url) =>
        Effect.sync(() => {
          opened.push(Redacted.value(url));
          return { url: Redacted.value(url) } as unknown as SqlClient;
        }),
      );
      const cluster = Redacted.make("postgres://cluster");
      // Three models' first instances start at once, and more follow.
      const [a, b, c] = yield* Effect.all([pool(cluster), pool(cluster), pool(cluster)], {
        concurrency: "unbounded",
      });
      yield* pool(cluster);
      expect(opened).toEqual(["postgres://cluster"]);
      expect(b).toBe(a);
      expect(c).toBe(a);
      // Another database has a pool of its own.
      yield* pool(Redacted.make("postgres://other"));
      expect(opened).toEqual(["postgres://cluster", "postgres://other"]);
    }),
  );

  it.effect("a storage pool that fails to open is opened again by the next instance", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const pool = makeStoragePools(() =>
        Effect.suspend(() =>
          ++attempts === 1
            ? Effect.die(new Error("the database is not up yet"))
            : Effect.succeed({} as SqlClient),
        ),
      );
      const url = Redacted.make("postgres://cluster");
      expect((yield* Effect.exit(pool(url)))._tag).toBe("Failure");
      yield* pool(url);
      yield* pool(url);
      expect(attempts).toBe(2);
    }),
  );
});
