import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { randomUUID } from "node:crypto";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getPool = (
  resourceGroupName: string,
  serverName: string,
  elasticPoolName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* sql.GetElasticPool({
      subscriptionId,
      resourceGroupName,
      serverName,
      elasticPoolName,
    });
  });

const poolGone = (
  resourceGroupName: string,
  serverName: string,
  elasticPoolName: string,
) =>
  getPool(resourceGroupName, serverName, elasticPoolName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (props: {
  password: Redacted.Redacted<string>;
  minCapacity: number;
  pooledDatabase: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    // The free trial refuses new SQL servers in eastus (`ProvisioningDisabled`).
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "centralus",
    });
    const server = yield* Azure.Sql.Server("Db", {
      resourceGroup: group.resourceGroupName,
      location: group.location,
      administratorLogin: "alchemyadmin",
      administratorLoginPassword: props.password,
    });
    const pool = yield* Azure.Sql.ElasticPool("Pool", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      sku: { name: "BasicPool", tier: "Basic", capacity: 50 },
      perDatabaseSettings: { minCapacity: props.minCapacity, maxCapacity: 5 },
      tags: props.tags,
    });
    const database = props.pooledDatabase
      ? yield* Azure.Sql.Database("Tenant", {
          resourceGroup: group.resourceGroupName,
          server: server.serverName,
          elasticPoolId: pool.elasticPoolId,
          requestedBackupStorageRedundancy: "Local",
        })
      : undefined;
    return { group, server, pool, database };
  });

// BasicPool 50 eDTU (~$0.10/hour, billed hourly) plus a pooled database:
// about $0.10 per run.
test.provider(
  "create, update, pool a database, and delete an elastic pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = Redacted.make(
        `Az!${yield* Effect.sync(() => randomUUID())}`,
      );

      const { group, server, pool } = yield* stack.deploy(
        program({
          password,
          minCapacity: 0,
          pooledDatabase: false,
          tags: { env: "test" },
        }),
      );
      expect(pool.state).toEqual("Ready");
      expect(pool.skuName).toEqual("BasicPool");
      expect(pool.skuCapacity).toEqual(50);
      const observed = yield* getPool(
        group.resourceGroupName,
        server.serverName,
        pool.elasticPoolName,
      );
      expect(observed.properties?.perDatabaseSettings?.maxCapacity).toEqual(5);
      expect(observed.tags?.env).toEqual("test");

      // In place: per-database minimum, tags, and a pooled database.
      const updated = yield* stack.deploy(
        program({
          password,
          minCapacity: 5,
          pooledDatabase: true,
          tags: { env: "prod" },
        }),
      );
      expect(updated.pool.elasticPoolId).toEqual(pool.elasticPoolId);
      const reobserved = yield* getPool(
        group.resourceGroupName,
        server.serverName,
        pool.elasticPoolName,
      );
      expect(reobserved.properties?.perDatabaseSettings?.minCapacity).toEqual(
        5,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(updated.database?.elasticPoolId?.toLowerCase()).toEqual(
        pool.elasticPoolId.toLowerCase(),
      );
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const pooled = yield* sql.GetDatabase({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        serverName: server.serverName,
        databaseName: updated.database!.databaseName,
      });
      expect(pooled.sku?.name).toEqual("ElasticPool");

      yield* stack.destroy();
      expect(
        yield* poolGone(
          group.resourceGroupName,
          server.serverName,
          pool.elasticPoolName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:sql", "live"],
    timeout: 600_000,
  },
);
