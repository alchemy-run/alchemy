import * as Azure from "@alchemy.run/azure";
import * as storage from "@distilled.cloud/azure/storage";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const getBackup = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetWebAppBackupConfiguration({ subscriptionId, resourceGroupName, name });
  });

/** "gone" once the app reports no backup schedule (or no configuration). */
const backupGone = (resourceGroupName: string, name: string) =>
  getBackup(resourceGroupName, name).pipe(
    Effect.map((observed) =>
      observed.properties?.backupSchedule ? ("found" as const) : ("gone" as const),
    ),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

/** A container SAS URL with the read/write/list/delete rights backups need. */
const containerSasUrl = (resourceGroupName: string, accountName: string, container: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const expiry = yield* Effect.sync(() =>
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    );
    const { serviceSasToken } = yield* storage.ListStorageAccountServiceSAS({
      subscriptionId,
      resourceGroupName,
      accountName,
      canonicalizedResource: `/blob/${accountName}/${container}`,
      signedResource: "c",
      signedPermission: "rwdl",
      signedProtocol: "https",
      signedExpiry: expiry,
    });
    return `https://${accountName}.blob.core.windows.net/${container}?${serviceSasToken}`;
  });

const storageProgram = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const account = yield* Azure.Storage.StorageAccount("Storage", {
    resourceGroup: group.resourceGroupName,
    location: "westus2",
  });
  const backups = yield* Azure.Storage.BlobContainer("Backups", {
    resourceGroup: group.resourceGroupName,
    storageAccount: account.storageAccountName,
  });
  return { group, account, backups };
});

const program = (
  sasUrl: string,
  backup: { frequencyInterval: number; retentionPeriodInDays: number } | undefined,
) =>
  Effect.gen(function* () {
    const { group } = yield* storageProgram;
    // Backups need a Standard (S1) plan; eastus has zero App Service quota,
    // westus2 accepts S1 plans.
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      sku: "S1",
      os: "linux",
    });
    const app = yield* Azure.Web.WebApp("Site", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      os: "linux",
      siteConfig: { alwaysOn: false },
    });
    const configuration =
      backup === undefined
        ? undefined
        : yield* Azure.Web.WebAppBackupConfiguration("BackupConfig", {
            resourceGroup: group.resourceGroupName,
            siteName: app.siteName,
            storageAccountUrl: Redacted.make(sasUrl),
            backupName: "alchemy-backup",
            backupSchedule: {
              frequencyInterval: backup.frequencyInterval,
              frequencyUnit: "Day",
              retentionPeriodInDays: backup.retentionPeriodInDays,
            },
          });
    return { group, app, configuration };
  });

// S1 plan: ~$0.10/h, about $0.02 per run (Standard_LRS storage; no backup
// runs within the test). Provisioning: ~3 minutes.
test.provider(
  "schedule, update, and remove app backups",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, backups } = yield* stack.deploy(storageProgram);
      const sasUrl = yield* containerSasUrl(
        group.resourceGroupName,
        account.storageAccountName,
        backups.containerName,
      );

      const { app, configuration } = yield* stack.deploy(
        program(sasUrl, { frequencyInterval: 1, retentionPeriodInDays: 7 }),
      );
      expect(configuration?.enabled).toEqual(true);
      expect(configuration?.frequencyInterval).toEqual(1);
      const observed = yield* getBackup(group.resourceGroupName, app.siteName);
      expect(observed.properties?.backupName).toEqual("alchemy-backup");
      expect(observed.properties?.backupSchedule?.frequencyUnit).toEqual("Day");
      expect(observed.properties?.backupSchedule?.retentionPeriodInDays).toEqual(7);

      // In-place update: back up every 2 days, keep 14 days.
      const updated = yield* stack.deploy(
        program(sasUrl, { frequencyInterval: 2, retentionPeriodInDays: 14 }),
      );
      expect(updated.configuration?.frequencyInterval).toEqual(2);
      const reobserved = yield* getBackup(group.resourceGroupName, app.siteName);
      expect(reobserved.properties?.backupSchedule?.frequencyInterval).toEqual(2);
      expect(reobserved.properties?.backupSchedule?.retentionPeriodInDays).toEqual(14);

      // Remove only the configuration.
      yield* stack.deploy(program(sasUrl, undefined));
      expect(yield* backupGone(group.resourceGroupName, app.siteName)).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);
