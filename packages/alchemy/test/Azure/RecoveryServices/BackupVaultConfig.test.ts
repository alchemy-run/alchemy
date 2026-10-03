import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as backup from "@distilled.cloud/azure/recoveryservicesbackup";
import { expect } from "alchemy-test";
import { runPaidOnly } from "../gates.ts";
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

// Vaults created with current API versions get soft delete `AlwaysON`
// set through the vault API, after which this legacy API rejects every
// soft delete change with `BMSUserErrorSoftDeleteUseVaultApi` (and the
// vault API cannot leave `AlwaysON` either). The full lifecycle needs a
// legacy vault whose soft delete was never set through the vault API,
// which can no longer be created; run with AZURE_TEST_PAID=1 against one.
test.provider.skipIf(!runPaidOnly)(
  "manage and restore a vault's soft delete settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, owner } = yield* stack.deploy(groupOnly);
      const rg = group.resourceGroupName;
      yield* createVault(rg, VAULT, owner);
      // New vaults start with soft delete AlwaysON (editable until changed).
      const initial = yield* getConfig(rg);
      expect(initial.properties?.isSoftDeleteFeatureStateEditable).toEqual(
        true,
      );

      // Create: disable soft delete.
      const created = yield* stack.deploy(
        program({ softDeleteFeatureState: "Disabled" }),
      );
      expect(created.config.softDeleteFeatureState).toEqual("Disabled");
      expect((yield* getConfig(rg)).properties?.softDeleteFeatureState).toEqual(
        "Disabled",
      );

      // In-place: re-enable with a 30-day retention.
      const updated = yield* stack.deploy(
        program({
          softDeleteFeatureState: "Enabled",
          softDeleteRetentionPeriodInDays: 30,
        }),
      );
      expect(updated.config.vaultConfigId).toEqual(
        created.config.vaultConfigId,
      );
      const reobserved = yield* getConfig(rg);
      expect(reobserved.properties?.softDeleteFeatureState).toEqual("Enabled");
      expect(reobserved.properties?.softDeleteRetentionPeriodInDays).toEqual(
        30,
      );

      // Delete restores Azure's defaults (Enabled, 14 days).
      yield* stack.deploy(groupOnly);
      const restored = yield* getConfig(rg);
      expect(restored.properties?.softDeleteFeatureState).toEqual("Enabled");
      expect(restored.properties?.softDeleteRetentionPeriodInDays).toEqual(14);

      yield* deleteVault(rg, VAULT);
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free vault, ~2 minutes): matching settings converge
// without a write, and a soft delete change on a new vault fails with the
// typed error.
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
