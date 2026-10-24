import * as Azure from "@alchemy.run/azure";
import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, VAULT_LOCATION, vaultStack } from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

/** Vault plus an Azure Migrate hub with its server migration tool (all free). */
const migrateStack = Effect.gen(function* () {
  const { group, vault } = yield* vaultStack;
  const hub = yield* Azure.Migrate.MigrateProject("Hub", {
    resourceGroup: group.resourceGroupName,
    location: VAULT_LOCATION,
  });
  const migration = yield* Azure.Migrate.Solution("Migration", {
    resourceGroup: group.resourceGroupName,
    migrateProject: hub.migrateProjectName,
    name: "Servers-Migration-ServerMigration",
    tool: "ServerMigration",
    purpose: "Migration",
    goal: "Servers",
  });
  return { group, vault, hub, migration };
});

const program = (vmwareToAzureProviderType?: string) =>
  Effect.gen(function* () {
    const base = yield* migrateStack;
    const settings = yield* Azure.SiteRecovery.VaultSetting("Settings", {
      resourceGroup: base.group.resourceGroupName,
      vault: base.vault.vaultName,
      migrationSolutionId: base.migration.solutionId,
      vmwareToAzureProviderType,
    });
    return { ...base, settings };
  });

const getSetting = (rg: string, vault: string) =>
  Effect.gen(function* () {
    return yield* asr.GetReplicationVaultSetting({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      resourceName: vault,
      vaultSettingName: "default",
    });
  });

// Vault, Migrate hub, and vault settings are free; ~2 minutes.
test.provider(
  "configure and update site recovery vault settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create (configure the vault singleton): link the migration tool only.
      const created = yield* stack.deploy(program());
      const rg = created.group.resourceGroupName;
      const vault = created.vault.vaultName;
      const solutionId = created.migration.solutionId.toLowerCase();
      expect(created.settings.vaultSettingName).toEqual("default");
      expect(created.settings.vaultSettingId.toLowerCase()).toContain(
        `/vaults/${vault.toLowerCase()}/replicationvaultsettings/default`,
      );
      const observed = yield* getSetting(rg, vault);
      expect(observed.properties?.migrationSolutionId?.toLowerCase()).toEqual(solutionId);

      // In place: set the VMware provider type; the solution link is kept.
      const updated = yield* stack.deploy(program("VMwareCbt"));
      expect(updated.settings.vaultSettingId).toEqual(created.settings.vaultSettingId);
      expect(updated.settings.vmwareToAzureProviderType).toEqual("VMwareCbt");
      const reobserved = yield* getSetting(rg, vault);
      expect(reobserved.properties?.vmwareToAzureProviderType).toEqual("VMwareCbt");
      expect(reobserved.properties?.migrationSolutionId?.toLowerCase()).toEqual(solutionId);

      // Delete: no delete API, the singleton keeps its value until the vault goes.
      yield* stack.deploy(migrateStack);
      const kept = yield* getSetting(rg, vault);
      expect(kept.properties?.vmwareToAzureProviderType).toEqual("VMwareCbt");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
