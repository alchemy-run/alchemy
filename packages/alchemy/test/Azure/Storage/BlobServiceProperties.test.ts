import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Azure.providers() });

const getService = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetBlobServiceServiceProperties({
      subscriptionId,
      resourceGroupName,
      accountName,
    });
  });

type Settings = Omit<
  Azure.Storage.BlobServicePropertiesProps,
  "resourceGroup" | "storageAccount"
>;

const program = (settings?: Settings) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const blob = settings
      ? yield* Azure.Storage.BlobServiceProperties("BlobSettings", {
          ...settings,
          resourceGroup: group.resourceGroupName,
          storageAccount: account.storageAccountName,
        })
      : undefined;
    return { group, account, blob };
  });

test.provider(
  "configure, update, and reset blob service properties",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          isVersioningEnabled: true,
          deleteRetentionPolicy: { enabled: true, days: 7 },
          cors: [
            {
              allowedOrigins: ["https://app.example.com"],
              allowedMethods: ["GET", "PUT"],
              maxAgeInSeconds: 600,
            },
          ],
        }),
      );
      const rg = created.group.resourceGroupName;
      const acct = created.account.storageAccountName;
      expect(created.blob!.isVersioningEnabled).toEqual(true);
      const observed = yield* getService(rg, acct);
      expect(observed.properties?.isVersioningEnabled).toEqual(true);
      expect(observed.properties?.deleteRetentionPolicy?.enabled).toEqual(true);
      expect(observed.properties?.deleteRetentionPolicy?.days).toEqual(7);
      expect(observed.properties?.cors?.corsRules?.[0]?.allowedOrigins).toEqual(
        ["https://app.example.com"],
      );

      // In-place update: longer retention, change feed, container soft
      // delete, and a different CORS origin.
      yield* stack.deploy(
        program({
          isVersioningEnabled: true,
          deleteRetentionPolicy: { enabled: true, days: 14 },
          containerDeleteRetentionPolicy: { enabled: true, days: 3 },
          changeFeed: { enabled: true, retentionInDays: 7 },
          cors: [
            {
              allowedOrigins: ["https://admin.example.com"],
              allowedMethods: ["GET"],
            },
          ],
        }),
      );
      const reobserved = yield* getService(rg, acct);
      expect(reobserved.properties?.deleteRetentionPolicy?.days).toEqual(14);
      expect(
        reobserved.properties?.containerDeleteRetentionPolicy?.enabled,
      ).toEqual(true);
      expect(reobserved.properties?.changeFeed?.enabled).toEqual(true);
      expect(
        reobserved.properties?.cors?.corsRules?.map((r) => r.allowedOrigins),
      ).toEqual([["https://admin.example.com"]]);

      // Removing the resource resets the managed settings to defaults.
      yield* stack.deploy(program());
      const reset = yield* getService(rg, acct);
      expect(reset.properties?.isVersioningEnabled ?? false).toEqual(false);
      expect(reset.properties?.deleteRetentionPolicy?.enabled ?? false).toEqual(
        false,
      );
      expect(
        reset.properties?.containerDeleteRetentionPolicy?.enabled ?? false,
      ).toEqual(false);
      expect(reset.properties?.changeFeed?.enabled ?? false).toEqual(false);
      expect(reset.properties?.cors?.corsRules ?? []).toEqual([]);

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);
