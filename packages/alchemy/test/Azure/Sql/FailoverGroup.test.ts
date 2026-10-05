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

const getGroup = (
  resourceGroupName: string,
  serverName: string,
  failoverGroupName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* sql.GetFailoverGroup({
      subscriptionId,
      resourceGroupName,
      serverName,
      failoverGroupName,
    });
  });

const groupGone = (
  resourceGroupName: string,
  serverName: string,
  failoverGroupName: string,
) =>
  getGroup(resourceGroupName, serverName, failoverGroupName).pipe(
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
  replicate: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    // The free trial refuses new SQL servers in eastus/eastus2/westus2
    // (`ProvisioningDisabled`); centralus and westus3 accept them.
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "centralus",
    });
    const primary = yield* Azure.Sql.Server("Primary", {
      resourceGroup: group.resourceGroupName,
      location: "centralus",
      administratorLogin: "alchemyadmin",
      administratorLoginPassword: props.password,
    });
    const secondary = yield* Azure.Sql.Server("Secondary", {
      resourceGroup: group.resourceGroupName,
      location: "westus3",
      administratorLogin: "alchemyadmin",
      administratorLoginPassword: props.password,
    });
    const database = yield* Azure.Sql.Database("App", {
      resourceGroup: group.resourceGroupName,
      server: primary.serverName,
      sku: { name: "Basic" },
      requestedBackupStorageRedundancy: "Local",
    });
    const fog = yield* Azure.Sql.FailoverGroup("Fog", {
      resourceGroup: group.resourceGroupName,
      server: primary.serverName,
      partnerServers: [secondary.serverId],
      databases: props.replicate ? [database.databaseId] : [],
      tags: props.tags,
    });
    return { group, primary, secondary, database, fog };
  });

// Two logical servers (free) plus a Basic primary and its geo-secondary
// (~$0.007/hour each) for ~10 minutes: about $0.01.
test.provider(
  "create, update, and delete a sql failover group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = Redacted.make(
        `Az!${yield* Effect.sync(() => randomUUID())}`,
      );

      const { group, primary, secondary, fog } = yield* stack.deploy(
        program({ password, replicate: false, tags: { env: "test" } }),
      );
      expect(fog.failoverGroupName).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
      expect(fog.readWriteListenerEndpoint).toEqual(
        `${fog.failoverGroupName}.database.windows.net`,
      );
      expect(fog.replicationRole).toEqual("Primary");
      expect(fog.partnerServers.map((id) => id.toLowerCase())).toEqual([
        secondary.serverId.toLowerCase(),
      ]);
      const observed = yield* getGroup(
        group.resourceGroupName,
        primary.serverName,
        fog.failoverGroupName,
      );
      expect(observed.properties?.readWriteEndpoint.failoverPolicy).toEqual(
        "Manual",
      );
      expect(observed.properties?.databases ?? []).toEqual([]);
      expect(observed.tags?.env).toEqual("test");

      // In place: replicate the database and retag.
      const updated = yield* stack.deploy(
        program({ password, replicate: true, tags: { env: "prod" } }),
      );
      expect(updated.fog.failoverGroupId).toEqual(fog.failoverGroupId);
      const reobserved = yield* getGroup(
        group.resourceGroupName,
        primary.serverName,
        fog.failoverGroupName,
      );
      expect(
        (reobserved.properties?.databases ?? []).map((id) => id.toLowerCase()),
      ).toEqual([updated.database.databaseId.toLowerCase()]);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* groupGone(
          group.resourceGroupName,
          primary.serverName,
          fog.failoverGroupName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:sql", "live"],
    timeout: 600_000,
  },
);
