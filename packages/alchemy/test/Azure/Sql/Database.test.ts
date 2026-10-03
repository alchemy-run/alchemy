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

const getDatabase = (
  resourceGroupName: string,
  serverName: string,
  databaseName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* sql.GetDatabase({
      subscriptionId,
      resourceGroupName,
      serverName,
      databaseName,
    });
  });

const databaseGone = (
  resourceGroupName: string,
  serverName: string,
  databaseName: string,
) =>
  getDatabase(resourceGroupName, serverName, databaseName).pipe(
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

const GB = 1024 * 1024 * 1024;

const program = (props: {
  password: Redacted.Redacted<string>;
  sku: string;
  maxSizeBytes: number;
  collation?: string;
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
    const database = yield* Azure.Sql.Database("App", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      sku: { name: props.sku },
      maxSizeBytes: props.maxSizeBytes,
      collation: props.collation,
      requestedBackupStorageRedundancy: "Local",
      tags: props.tags,
    });
    return { group, server, database };
  });

// Basic ($4.90/month) and S0 ($15/month) for ~10 minutes: about $0.01.
test.provider(
  "create, scale, replace, and delete a sql database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = Redacted.make(
        `Az!${yield* Effect.sync(() => randomUUID())}`,
      );

      const { group, server, database } = yield* stack.deploy(
        program({
          password,
          sku: "Basic",
          maxSizeBytes: GB,
          tags: { env: "test" },
        }),
      );
      expect(database.status).toEqual("Online");
      expect(database.skuName).toEqual("Basic");
      expect(database.location.toLowerCase()).toEqual("centralus");
      expect(database.tags).toEqual({ env: "test" });
      const observed = yield* getDatabase(
        group.resourceGroupName,
        server.serverName,
        database.databaseName,
      );
      expect(observed.properties?.currentServiceObjectiveName).toEqual("Basic");
      expect(observed.properties?.maxSizeBytes).toEqual(GB);
      expect(observed.tags?.["alchemy::id"]).toEqual("App");

      // In place: tags, max size, and a Basic -> S0 scale.
      const updated = yield* stack.deploy(
        program({
          password,
          sku: "S0",
          maxSizeBytes: 2 * GB,
          tags: { env: "prod" },
        }),
      );
      expect(updated.database.databaseId).toEqual(database.databaseId);
      expect(updated.database.currentServiceObjectiveName).toEqual("S0");
      const reobserved = yield* getDatabase(
        group.resourceGroupName,
        server.serverName,
        database.databaseName,
      );
      expect(reobserved.sku?.name).toEqual("Standard");
      expect(reobserved.properties?.currentServiceObjectiveName).toEqual("S0");
      expect(reobserved.properties?.maxSizeBytes).toEqual(2 * GB);
      expect(reobserved.tags?.env).toEqual("prod");

      // Collation is create-only: changing it replaces the database.
      const replaced = yield* stack.deploy(
        program({
          password,
          sku: "S0",
          maxSizeBytes: 2 * GB,
          collation: "SQL_Latin1_General_CP1_CS_AS",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.database.databaseName).not.toEqual(database.databaseName);
      expect(replaced.database.collation).toEqual(
        "SQL_Latin1_General_CP1_CS_AS",
      );
      expect(
        yield* databaseGone(
          group.resourceGroupName,
          server.serverName,
          database.databaseName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* databaseGone(
          group.resourceGroupName,
          server.serverName,
          replaced.database.databaseName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:sql", "live"],
    timeout: 600_000,
  },
);
