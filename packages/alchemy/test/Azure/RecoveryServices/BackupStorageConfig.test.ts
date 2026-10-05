import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as backup from "@distilled.cloud/azure/recoveryservicesbackup";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  createVault,
  deleteVault,
  groupOnly,
  logLevel,
  subscription,
  tags,
} from "./vault.ts";

const { test } = Test.make({ providers: Azure.providers() });

const VAULT = "alchemy-test-rsv-storageconfig";

const program = (
  storageType: "LocallyRedundant" | "ZoneRedundant" | "GeoRedundant",
) =>
  Effect.gen(function* () {
    const { group, owner } = yield* groupOnly;
    const config = yield* Azure.RecoveryServices.BackupStorageConfig(
      "Storage",
      {
        resourceGroup: group.resourceGroupName,
        vault: VAULT,
        storageType,
      },
    );
    return { group, owner, config };
  });

const getConfig = (resourceGroupName: string) =>
  Effect.gen(function* () {
    return yield* backup.GetBackupResourceStorageConfigsNonCRR({
      subscriptionId: yield* subscription,
      resourceGroupName,
      vaultName: VAULT,
    });
  });

// Free vault, ~5 minutes. Vaults created with current API versions have
// their redundancy managed by the vault API, so every change below goes
// through the provider's vault-API fallback.
test.provider(
  "manage and restore a vault's backup storage redundancy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, owner } = yield* stack.deploy(groupOnly);
      const rg = group.resourceGroupName;
      yield* createVault(rg, VAULT, owner);

      // Matching settings converge without a write.
      const matching = yield* stack.deploy(program("GeoRedundant"));
      expect(matching.config.storageType).toEqual("GeoRedundant");
      expect(matching.config.storageConfigId).toContain(
        `/vaults/${VAULT}/backupstorageconfig/vaultstorageconfig`,
      );

      // Update: locally redundant storage.
      const created = yield* stack.deploy(program("LocallyRedundant"));
      expect(created.config.storageType).toEqual("LocallyRedundant");
      expect(created.config.storageTypeState).toEqual("Unlocked");
      expect((yield* getConfig(rg)).properties?.storageType).toEqual(
        "LocallyRedundant",
      );

      // In-place: zone-redundant storage.
      const updated = yield* stack.deploy(program("ZoneRedundant"));
      expect(updated.config.storageConfigId).toEqual(
        created.config.storageConfigId,
      );
      expect((yield* getConfig(rg)).properties?.storageType).toEqual(
        "ZoneRedundant",
      );

      // Delete restores the default geo-redundant storage.
      yield* stack.deploy(groupOnly);
      expect((yield* getConfig(rg)).properties?.storageType).toEqual(
        "GeoRedundant",
      );

      yield* deleteVault(rg, VAULT);
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
