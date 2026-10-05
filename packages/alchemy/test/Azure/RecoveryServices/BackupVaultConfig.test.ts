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

const VAULT = "alchemy-test-rsv-vaultconfig";

const program = (props: {
  softDeleteFeatureState: "Enabled" | "Disabled" | "AlwaysON";
  softDeleteRetentionPeriodInDays?: number;
}) =>
  Effect.gen(function* () {
    const { group, owner } = yield* groupOnly;
    const config = yield* Azure.RecoveryServices.BackupVaultConfig("Config", {
      resourceGroup: group.resourceGroupName,
      vault: VAULT,
      ...props,
    });
    return { group, owner, config };
  });

const getConfig = (resourceGroupName: string) =>
  Effect.gen(function* () {
    return yield* backup.GetBackupResourceVaultConfig({
      subscriptionId: yield* subscription,
      resourceGroupName,
      vaultName: VAULT,
    });
  });

// Free vault, ~5 minutes. Vaults created with current API versions have
// soft delete `AlwaysON` managed by the vault API (Azure no longer lets new
// vaults disable soft delete), so the retention changes below go through
// the provider's vault-API fallback.
test.provider(
  "manage and restore a vault's soft delete settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, owner } = yield* stack.deploy(groupOnly);
      const rg = group.resourceGroupName;
      yield* createVault(rg, VAULT, owner);

      // Create: keep soft-deleted items for 20 days.
      const created = yield* stack.deploy(
        program({
          softDeleteFeatureState: "AlwaysON",
          softDeleteRetentionPeriodInDays: 20,
        }),
      );
      expect(created.config.softDeleteFeatureState).toEqual("AlwaysON");
      expect(created.config.softDeleteRetentionPeriodInDays).toEqual(20);
      expect(
        (yield* getConfig(rg)).properties?.softDeleteRetentionPeriodInDays,
      ).toEqual(20);

      // In-place: 30-day retention.
      const updated = yield* stack.deploy(
        program({
          softDeleteFeatureState: "AlwaysON",
          softDeleteRetentionPeriodInDays: 30,
        }),
      );
      expect(updated.config.vaultConfigId).toEqual(
        created.config.vaultConfigId,
      );
      const reobserved = yield* getConfig(rg);
      expect(reobserved.properties?.softDeleteFeatureState).toEqual("AlwaysON");
      expect(reobserved.properties?.softDeleteRetentionPeriodInDays).toEqual(
        30,
      );

      // Delete restores Azure's default retention (14 days).
      yield* stack.deploy(groupOnly);
      const restored = yield* getConfig(rg);
      expect(restored.properties?.softDeleteFeatureState).toEqual("AlwaysON");
      expect(restored.properties?.softDeleteRetentionPeriodInDays).toEqual(14);

      yield* deleteVault(rg, VAULT);
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Free vault, ~2 minutes: matching settings converge without a write, and
// leaving the irreversible `AlwaysON` fails with the typed error.
test.provider(
  "a new vault rejects soft delete changes with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, owner } = yield* stack.deploy(groupOnly);
      const rg = group.resourceGroupName;
      yield* createVault(rg, VAULT, owner);

      const matching = yield* stack.deploy(
        program({ softDeleteFeatureState: "AlwaysON" }),
      );
      expect(matching.config.softDeleteFeatureState).toEqual("AlwaysON");
      expect(matching.config.vaultConfigId).toContain(
        `/vaults/${VAULT}/backupconfig/vaultconfig`,
      );

      const error = yield* stack
        .deploy(program({ softDeleteFeatureState: "Disabled" }))
        .pipe(Effect.flip);
      expect(JSON.stringify(error)).toContain("BackupConfigManagedByVaultApi");
      expect((yield* getConfig(rg)).properties?.softDeleteFeatureState).toEqual(
        "AlwaysON",
      );

      yield* stack.deploy(groupOnly);
      yield* deleteVault(rg, VAULT);
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
