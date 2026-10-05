import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dataprotection from "@distilled.cloud/azure/dataprotection";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVault = (resourceGroupName: string, vaultName: string) =>
  Effect.gen(function* () {
    return yield* dataprotection.GetBackupVault({
      subscriptionId: yield* subscription,
      resourceGroupName,
      vaultName,
    });
  });

const program = (props: {
  redundancy: Azure.DataProtection.BackupRedundancy;
  alerts: "Enabled" | "Disabled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vault = yield* Azure.DataProtection.BackupVault("Vault", {
      resourceGroup: group.resourceGroupName,
      storageSettings: [
        { datastoreType: "VaultStore", type: props.redundancy },
      ],
      alertsForAllJobFailures: props.alerts,
      tags: props.tags,
    });
    return { group, vault };
  });

// Empty Backup vault: $0, < 1 minute per create.
test.provider(
  "create, update, replace, and delete a backup vault",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vault } = yield* stack.deploy(
        program({
          redundancy: "LocallyRedundant",
          alerts: "Enabled",
          tags: { env: "test" },
        }),
      );
      const rg = group.resourceGroupName;
      expect(vault.backupVaultName).toMatch(/^[a-zA-Z][a-zA-Z0-9-]{1,49}$/);
      expect(vault.identityType).toEqual("SystemAssigned");
      expect(vault.principalId).toBeTruthy();
      expect(vault.softDeleteState).toEqual("AlwaysOn");
      const observed = yield* getVault(rg, vault.backupVaultName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.storageSettings?.[0]?.type).toEqual(
        "LocallyRedundant",
      );
      expect(
        observed.properties.monitoringSettings?.azureMonitorAlertSettings
          ?.alertsForAllJobFailures,
      ).toEqual("Enabled");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Vault");

      // In-place update: alert setting and tags.
      const updated = yield* stack.deploy(
        program({
          redundancy: "LocallyRedundant",
          alerts: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(updated.vault.backupVaultName).toEqual(vault.backupVaultName);
      const reobserved = yield* getVault(rg, vault.backupVaultName);
      expect(
        reobserved.properties.monitoringSettings?.azureMonitorAlertSettings
          ?.alertsForAllJobFailures,
      ).toEqual("Disabled");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: storage redundancy is immutable.
      const replaced = yield* stack.deploy(
        program({
          redundancy: "GeoRedundant",
          alerts: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.vault.backupVaultName).not.toEqual(vault.backupVaultName);
      const geo = yield* getVault(rg, replaced.vault.backupVaultName);
      expect(geo.properties.storageSettings?.[0]?.type).toEqual("GeoRedundant");
      expect(yield* waitGone(getVault(rg, vault.backupVaultName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(getVault(rg, replaced.vault.backupVaultName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
