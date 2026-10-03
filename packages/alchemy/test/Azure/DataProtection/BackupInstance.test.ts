import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dataprotection from "@distilled.cloud/azure/dataprotection";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  BLOB_DATASOURCE,
  blobRetention,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/** Built-in `Storage Account Backup Contributor` role. */
const STORAGE_ACCOUNT_BACKUP_CONTRIBUTOR =
  "e5e2a7ff-d759-4cd2-bb51-3152d37e2eb1";

const getInstance = (
  resourceGroupName: string,
  vaultName: string,
  backupInstanceName: string,
) =>
  Effect.gen(function* () {
    return yield* dataprotection.GetBackupInstance({
      subscriptionId: yield* subscription,
      resourceGroupName,
      vaultName,
      backupInstanceName,
    });
  });

const program = (props: {
  instance?: { friendlyName: string; tags: Record<string, string> };
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Data", {
      resourceGroup: group.resourceGroupName,
    });
    const vault = yield* Azure.DataProtection.BackupVault("Vault", {
      resourceGroup: group.resourceGroupName,
    });
    const grant = yield* Azure.Authorization.RoleAssignment("VaultGrant", {
      scope: account.storageAccountId,
      roleDefinitionId: STORAGE_ACCOUNT_BACKUP_CONTRIBUTOR,
      principalId: vault.principalId.as<string>(),
      principalType: "ServicePrincipal",
    });
    const policy = yield* Azure.DataProtection.BackupPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
      backupVault: vault.backupVaultName,
      datasourceTypes: [BLOB_DATASOURCE],
      policyRules: blobRetention("P7D"),
    });
    // The instance is added in a later deploy so the role grant exists first.
    const instance = props.instance
      ? yield* Azure.DataProtection.BackupInstance("Blobs", {
          resourceGroup: group.resourceGroupName,
          backupVault: vault.backupVaultName,
          policyId: policy.backupPolicyId,
          dataSource: {
            resourceID: account.storageAccountId,
            datasourceType: BLOB_DATASOURCE,
          },
          // Updates of a blob instance are rejected without these.
          datasourceParameters: [
            {
              objectType: "BlobBackupDatasourceParameters",
              containersList: [],
            },
          ],
          friendlyName: props.instance.friendlyName,
          tags: props.instance.tags,
        })
      : undefined;
    return { group, account, vault, grant, policy, instance };
  });

// Standard_LRS account + empty-ish vault + operational blob backup (billed
// per protected instance-hour, ~$0.01 for a short run): ~5 minutes.
test.provider(
  "create, update, and delete a backup instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = yield* stack.deploy(program({}));
      const rg = base.group.resourceGroupName;
      const vaultName = base.vault.backupVaultName;

      const { instance } = yield* stack.deploy(
        program({ instance: { friendlyName: "blobs", tags: { env: "test" } } }),
      );
      expect(instance).toBeDefined();
      const name = instance!.backupInstanceName;
      expect(instance!.currentProtectionState).toEqual("ProtectionConfigured");
      expect(instance!.dataSourceId.toLowerCase()).toEqual(
        base.account.storageAccountId.toLowerCase(),
      );
      const observed = yield* getInstance(rg, vaultName, name);
      expect(observed.properties?.friendlyName).toEqual("blobs");
      expect(observed.properties?.policyInfo.policyId.toLowerCase()).toEqual(
        base.policy.backupPolicyId.toLowerCase(),
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Blobs");

      // In-place update: tags (the friendly name is create-only).
      const updated = yield* stack.deploy(
        program({
          instance: { friendlyName: "blobs-renamed", tags: { env: "prod" } },
        }),
      );
      expect(updated.instance!.backupInstanceName).toEqual(name);
      const reobserved = yield* getInstance(rg, vaultName, name);
      expect(reobserved.properties?.friendlyName).toEqual("blobs");
      expect(reobserved.properties?.currentProtectionState).toEqual(
        "ProtectionConfigured",
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Remove the instance before its role grant: Azure Backup locks the
      // storage account while protection is being removed.
      yield* stack.deploy(program({}));
      expect(yield* waitGone(getInstance(rg, vaultName, name))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getInstance(rg, vaultName, name))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
