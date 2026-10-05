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
    return yield* sql.GetBackupShortTermRetentionPolicy({
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
  policy: { retentionDays: number; diff: 12 | 24 } | undefined;
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
        : yield* Azure.Sql.BackupShortTermRetentionPolicy("Pitr", {
            resourceGroup: group.resourceGroupName,
            server: server.serverName,
            database: database.databaseName,
            retentionDays: props.policy.retentionDays,
            diffBackupIntervalInHours: props.policy.diff,
          });
    return { group, server, database, policy };
  });

// Basic database (~$0.007/hour) for a few minutes: well under $0.01.
test.provider(
  "set, update, and reset a sql database's short-term backup retention",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = Redacted.make(
        `Az!${yield* Effect.sync(() => randomUUID())}`,
      );

      const { group, server, database, policy } = yield* stack.deploy(
        program({ password, policy: { retentionDays: 3, diff: 24 } }),
      );
      expect(policy?.retentionDays).toEqual(3);
      const observed = yield* getPolicy(
        group.resourceGroupName,
        server.serverName,
        database.databaseName,
      );
      expect(observed.properties?.retentionDays).toEqual(3);
      expect(observed.properties?.diffBackupIntervalInHours).toEqual(24);

      // In place: widen the window, back to 12-hour differentials.
      yield* stack.deploy(
        program({ password, policy: { retentionDays: 5, diff: 12 } }),
      );
      const reobserved = yield* getPolicy(
        group.resourceGroupName,
        server.serverName,
        database.databaseName,
      );
      expect(reobserved.properties?.retentionDays).toEqual(5);
      expect(reobserved.properties?.diffBackupIntervalInHours).toEqual(12);

      // Removing the resource restores Azure's defaults.
      yield* stack.deploy(program({ password, policy: undefined }));
      expect(
        (yield* getPolicy(
          group.resourceGroupName,
          server.serverName,
          database.databaseName,
        )).properties?.retentionDays,
      ).toEqual(7);

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
