import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Azure.providers() });

const getService = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetFileServiceServiceProperties({
      subscriptionId,
      resourceGroupName,
      accountName,
    });
  });

type Settings = Omit<
  Azure.Storage.FileServicePropertiesProps,
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
    const file = settings
      ? yield* Azure.Storage.FileServiceProperties("FileSettings", {
          ...settings,
          resourceGroup: group.resourceGroupName,
          storageAccount: account.storageAccountName,
        })
      : undefined;
    return { group, account, file };
  });

// Standard_LRS account with no shares: ~$0, ~1 minute.
test.provider(
  "configure, update, and reset file service properties",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          shareDeleteRetentionPolicy: { enabled: true, days: 14 },
          smb: { versions: "SMB3.0;SMB3.1.1" },
          cors: [
            {
              allowedOrigins: ["https://app.example.com"],
              allowedMethods: ["GET"],
            },
          ],
        }),
      );
      const rg = created.group.resourceGroupName;
      const acct = created.account.storageAccountName;
      expect(created.file!.shareDeleteRetentionPolicy).toEqual({
        enabled: true,
        days: 14,
      });
      const observed = yield* getService(rg, acct);
      expect(observed.properties?.shareDeleteRetentionPolicy?.days).toEqual(14);
      expect(observed.properties?.protocolSettings?.smb?.versions).toEqual(
        "SMB3.0;SMB3.1.1",
      );
      expect(observed.properties?.cors?.corsRules?.[0]?.allowedOrigins).toEqual(
        ["https://app.example.com"],
      );

      // In-place update: disable share soft delete, tighten SMB further,
      // and drop CORS.
      yield* stack.deploy(
        program({
          shareDeleteRetentionPolicy: { enabled: false },
          smb: { versions: "SMB3.1.1", channelEncryption: "AES-256-GCM" },
          cors: [],
        }),
      );
      const reobserved = yield* getService(rg, acct);
      expect(
        reobserved.properties?.shareDeleteRetentionPolicy?.enabled,
      ).toEqual(false);
      expect(reobserved.properties?.protocolSettings?.smb?.versions).toEqual(
        "SMB3.1.1",
      );
      expect(
        reobserved.properties?.protocolSettings?.smb?.channelEncryption,
      ).toEqual("AES-256-GCM");
      expect(reobserved.properties?.cors?.corsRules ?? []).toEqual([]);

      // Removing the resource restores Azure's defaults.
      yield* stack.deploy(program());
      const reset = yield* getService(rg, acct);
      expect(reset.properties?.shareDeleteRetentionPolicy?.enabled).toEqual(
        true,
      );
      expect(reset.properties?.shareDeleteRetentionPolicy?.days).toEqual(7);
      expect(
        reset.properties?.protocolSettings?.smb?.versions?.split(";").sort(),
      ).toEqual(["SMB2.1", "SMB3.0", "SMB3.1.1"]);

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);
