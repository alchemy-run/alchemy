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

const getPolicy = (
  resourceGroupName: string,
  serverName: string,
  databaseName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* sql.GetLongTermRetentionPolicy({
      subscriptionId,
      resourceGroupName,
      serverName,
      databaseName,
      policyName: "default",
    });
  });

const databaseGone = (
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
  }).pipe(
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
  policy: { weekly: string; monthly?: string } | undefined;
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
      sku: { name: "Basic" },
      requestedBackupStorageRedundancy: "Local",
    });
    const policy =
      props.policy === undefined
        ? undefined
        : yield* Azure.Sql.LongTermRetentionPolicy("Ltr", {
            resourceGroup: group.resourceGroupName,
            server: server.serverName,
            database: database.databaseName,
            weeklyRetention: props.policy.weekly,
            monthlyRetention: props.policy.monthly,
          });
    return { group, server, database, policy };
  });

// Basic database (~$0.007/hour) for a few minutes and no long-term backup
// is taken within the run: well under $0.01.
test.provider(
  "set, update, and reset a sql database's long-term backup retention",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = Redacted.make(
        `Az!${yield* Effect.sync(() => randomUUID())}`,
      );

      const { group, server, database, policy } = yield* stack.deploy(
        program({ password, policy: { weekly: "P4W" } }),
      );
      expect(policy?.weeklyRetention).toEqual("P4W");
      const observed = yield* getPolicy(
        group.resourceGroupName,
        server.serverName,
        database.databaseName,
      );
      expect(observed.properties?.weeklyRetention).toEqual("P4W");
      expect(observed.properties?.monthlyRetention).toEqual("PT0S");

      // In place: shorter weekly, add monthly retention.
      yield* stack.deploy(
        program({ password, policy: { weekly: "P2W", monthly: "P3M" } }),
      );
      const reobserved = yield* getPolicy(
        group.resourceGroupName,
        server.serverName,
        database.databaseName,
      );
      expect(reobserved.properties?.weeklyRetention).toEqual("P2W");
      expect(reobserved.properties?.monthlyRetention).toEqual("P3M");

      // Removing the resource stops long-term retention.
      yield* stack.deploy(program({ password, policy: undefined }));
      const reset = yield* getPolicy(
        group.resourceGroupName,
        server.serverName,
        database.databaseName,
      );
      expect(reset.properties?.weeklyRetention).toEqual("PT0S");
      expect(reset.properties?.monthlyRetention).toEqual("PT0S");

      yield* stack.destroy();
      expect(
        yield* databaseGone(
          group.resourceGroupName,
          server.serverName,
          database.databaseName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:sql", "live"],
    timeout: 600_000,
  },
);
