import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { FakeRenderServer } from "./FakeRenderServer.ts";

describe(
  "Render Datastores (Postgres, KeyValue, Redis)",
  { tags: ["provider:render", "local"], timeout: 60_000 },
  () => {
    const fake = new FakeRenderServer({ postgresReadyAfterPolls: 3 });
    const t = Test.make({
      providers: fake.providersLayer({ pollIntervalMs: 1, pollMaxAttempts: 15 }),
    });
    t.afterAll(Effect.sync(() => fake.stop()));

    t.test.provider(
      "rejects invalid diskSizeGB and manages Postgres polling, replicas, parameterOverrides, replacements, KeyValue, and Redis",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          // Invalid diskSizeGB (not 1 and not a multiple of 5) must fail with RenderValidationError
          const invalidErr = yield* stack
            .deploy(
              Effect.gen(function* () {
                return yield* Render.Postgres("BadDiskDb", {
                  name: "bad-disk-db",
                  plan: "basic_256mb",
                  diskSizeGB: 3,
                });
              }),
            )
            .pipe(Effect.flip);
          expect(JSON.stringify(invalidErr)).toContain("RenderValidationError");

          // Clear state from failed partial deploy before main lifecycle
          yield* stack.destroy();
          fake.clearCalls();

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const proj = yield* Render.Project("DataProject", {
                name: "data-project",
                environments: {
                  staging: { name: "staging", protectedStatus: "unprotected" },
                  prod: { name: "prod", protectedStatus: "protected" },
                },
              });

              const pg = yield* Render.Postgres("MainPg", {
                name: "main-pg",
                plan: "basic_256mb",
                region: "oregon",
                version: "16",
                databaseName: "app_db",
                databaseUser: "app_user",
                diskSizeGB: 10,
                enableDiskAutoscaling: true,
                enableHighAvailability: false,
                environmentId: proj.environments.staging.id,
                parameterOverrides: {
                  work_mem: "32MB",
                  max_connections: "150",
                },
                ipAllowList: [{ cidrBlock: "10.0.0.0/8", description: "vpc" }],
                logStreamOverride: {
                  setting: "send",
                  endpoint: "pg-logs.example.test:6514",
                },
                readReplicas: [
                  {
                    name: "main-pg-replica-1",
                    parameterOverrides: { work_mem: "16MB" },
                    logStreamOverride: {
                      setting: "send",
                      endpoint: "replica-logs.example.test:6514",
                    },
                  },
                ],
              });

              const kv = yield* Render.KeyValue("AppKv", {
                name: "app-kv",
                plan: "starter",
                region: "oregon",
                environmentId: proj.environments.staging.id,
                maxmemoryPolicy: "allkeys_lru",
                persistenceMode: "snapshot",
                ipAllowList: [{ cidrBlock: "10.0.0.0/8", description: "internal" }],
                logStreamOverride: {
                  setting: "drop",
                },
              });

              const legacyRedis = yield* Render.Redis("LegacyCache", {
                name: "legacy-cache",
                plan: "starter",
                region: "oregon",
                environmentId: proj.environments.staging.id,
                maxmemoryPolicy: "volatile_lru",
              });

              return { proj, pg, kv, legacyRedis };
            }),
          );

          expect(deployed.pg.status).toBe("available");
          expect(deployed.pg.parameterOverrides).toEqual({
            work_mem: "32MB",
            max_connections: "150",
          });
          expect(deployed.pg.readReplicas.length).toBe(1);
          expect(deployed.pg.readReplicas[0]?.name).toBe("main-pg-replica-1");
          expect(deployed.pg.readReplicas[0]?.parameterOverrides).toEqual({ work_mem: "16MB" });
          expect(deployed.pg.readReplicas[0]?.logStreamOverride?.endpoint).toBe(
            "replica-logs.example.test:6514",
          );
          expect(deployed.pg.logStreamOverride?.endpoint).toBe("pg-logs.example.test:6514");
          expect(Redacted.value(deployed.pg.connectionInfo.internalConnectionString)).toContain(
            deployed.pg.id,
          );
          expect(Redacted.value(deployed.pg.connectionInfo.password)).toBe(
            `pgpass-${deployed.pg.id}`,
          );

          expect(deployed.kv.maxmemoryPolicy).toBe("allkeys_lru");
          expect(deployed.kv.logStreamOverride?.setting).toBe("drop");
          expect(Redacted.value(deployed.kv.connectionInfo.externalConnectionString)).toContain(
            deployed.kv.id,
          );
          expect(Redacted.value(deployed.legacyRedis.connectionInfo.redisCLICommand)).toContain(
            "redis-cli",
          );

          // Confirm Postgres readiness poller waited across multiple GET /postgres/{id} checks
          const pgGetCalls = fake.calls.filter(
            (c) => c.method === "GET" && c.path === `/postgres/${deployed.pg.id}`,
          );
          expect(pgGetCalls.length).toBeGreaterThanOrEqual(3);

          // Lookup & list check via providers
          const pgProvider = yield* Provider.findProvider(Render.Postgres);
          const kvProvider = yield* Provider.findProvider(Render.KeyValue);
          const redisProvider = yield* Provider.findProvider(Render.Redis);
          expect((yield* pgProvider.lookup!({ name: "main-pg" }))?.id).toBe(deployed.pg.id);
          expect((yield* kvProvider.lookup!({ name: "app-kv" }))?.id).toBe(deployed.kv.id);
          expect((yield* redisProvider.lookup!({ name: "legacy-cache" }))?.id).toBe(
            deployed.legacyRedis.id,
          );
          expect((yield* pgProvider.list!()).length).toBe(1);
          expect((yield* kvProvider.list!()).length).toBe(1);
          expect((yield* redisProvider.list!()).length).toBe(1);

          // In-place update: move environmentId, clear Postgres parameterOverrides, drop replica, update KV policy & Redis
          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              const proj = yield* Render.Project("DataProject", {
                name: "data-project",
                environments: {
                  staging: { name: "staging", protectedStatus: "unprotected" },
                  prod: { name: "prod", protectedStatus: "protected" },
                },
              });

              const pg = yield* Render.Postgres("MainPg", {
                name: "main-pg",
                plan: "basic_1gb",
                region: "oregon",
                version: "16",
                databaseName: "app_db",
                databaseUser: "app_user",
                diskSizeGB: 15,
                environmentId: proj.environments.prod.id,
                readReplicas: [],
              });

              const kv = yield* Render.KeyValue("AppKv", {
                name: "app-kv",
                plan: "standard",
                region: "oregon",
                environmentId: proj.environments.prod.id,
                maxmemoryPolicy: "allkeys_lfu",
                logStreamOverride: {
                  setting: "send",
                  endpoint: "kv-logs.example.test:6514",
                },
              });

              const legacyRedis = yield* Render.Redis("LegacyCache", {
                name: "legacy-cache",
                plan: "standard",
                region: "oregon",
                environmentId: proj.environments.prod.id,
                maxmemoryPolicy: "noeviction",
              });

              return { proj, pg, kv, legacyRedis };
            }),
          );

          expect(updated.pg.id).toBe(deployed.pg.id);
          expect(updated.pg.environmentId).toBe(updated.proj.environments.prod.id);
          expect(updated.pg.diskSizeGB).toBe(15);
          expect(updated.pg.parameterOverrides).toBeUndefined();
          expect(updated.pg.readReplicas).toEqual([]);
          expect(updated.pg.logStreamOverride).toBeUndefined();

          expect(updated.kv.id).toBe(deployed.kv.id);
          expect(updated.kv.maxmemoryPolicy).toBe("allkeys_lfu");
          expect(updated.kv.logStreamOverride?.endpoint).toBe("kv-logs.example.test:6514");
          expect(updated.legacyRedis.id).toBe(deployed.legacyRedis.id);
          expect(updated.legacyRedis.maxmemoryPolicy).toBe("noeviction");

          // Replacing immutable fields (Postgres version, KeyValue region, Redis region) yields new IDs
          const replaced = yield* stack.deploy(
            Effect.gen(function* () {
              const proj = yield* Render.Project("DataProject", {
                name: "data-project",
                environments: {
                  staging: { name: "staging", protectedStatus: "unprotected" },
                  prod: { name: "prod", protectedStatus: "protected" },
                },
              });

              const pg = yield* Render.Postgres("MainPg", {
                name: "main-pg",
                plan: "basic_1gb",
                region: "oregon",
                version: "17",
                databaseName: "app_db",
                databaseUser: "app_user",
                diskSizeGB: 15,
                environmentId: proj.environments.prod.id,
              });

              const kv = yield* Render.KeyValue("AppKv", {
                name: "app-kv",
                plan: "standard",
                region: "frankfurt",
                environmentId: proj.environments.prod.id,
                maxmemoryPolicy: "allkeys_lfu",
              });

              const legacyRedis = yield* Render.Redis("LegacyCache", {
                name: "legacy-cache",
                plan: "standard",
                region: "frankfurt",
                environmentId: proj.environments.prod.id,
                maxmemoryPolicy: "noeviction",
              });

              return { pg, kv, legacyRedis };
            }),
          );

          expect(replaced.pg.id).not.toBe(deployed.pg.id);
          expect(replaced.pg.version).toBe("17");
          expect(replaced.kv.id).not.toBe(deployed.kv.id);
          expect(replaced.kv.region).toBe("frankfurt");
          expect(replaced.legacyRedis.id).not.toBe(deployed.legacyRedis.id);
          expect(replaced.legacyRedis.region).toBe("frankfurt");

          yield* stack.destroy();
          expect(fake.snapshotCounts().postgres).toBe(0);
          expect(fake.snapshotCounts().keyValues).toBe(0);
          expect(fake.snapshotCounts().projects).toBe(0);
        }),
      { tags: ["provider:render", "local"], timeout: 60_000 },
    );
  },
);
