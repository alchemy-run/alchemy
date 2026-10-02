import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as recoveryservices from "@distilled.cloud/azure/recoveryservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./vault.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVault = (resourceGroupName: string, vaultName: string) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    return yield* recoveryservices.GetVault({
      subscriptionId,
      resourceGroupName,
      vaultName,
    });
  });

const program = (props: {
  location: string;
  publicNetworkAccess: "Enabled" | "Disabled";
  identity?: Azure.RecoveryServices.VaultIdentity;
  retentionPeriodInDays: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const vault = yield* Azure.RecoveryServices.Vault("Vault", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      storageRedundancy: "LocallyRedundant",
      publicNetworkAccess: props.publicNetworkAccess,
      identity: props.identity,
      softDeleteRetentionPeriodInDays: props.retentionPeriodInDays,
      tags: props.tags,
    });
    return { group, vault };
  });

// An empty vault is free; create/update/delete take about a minute each.
test.provider(
  "create, update, replace, and delete a recovery services vault",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          location,
          publicNetworkAccess: "Enabled",
          retentionPeriodInDays: 14,
          tags: { env: "test" },
        }),
      );
      const { group, vault } = created;
      expect(vault.vaultName).toMatch(/^[A-Za-z][A-Za-z0-9-]{1,49}$/);
      expect(vault.location).toEqual(location);
      expect(vault.tags).toEqual({ env: "test" });

      const observed = yield* getVault(
        group.resourceGroupName,
        vault.vaultName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.publicNetworkAccess).toEqual("Enabled");
      expect(
        observed.properties?.redundancySettings?.standardTierStorageRedundancy,
      ).toEqual("LocallyRedundant");
      expect(
        observed.properties?.securitySettings?.softDeleteSettings
          ?.softDeleteState,
      ).toEqual("AlwaysON");
      expect(vault.softDeleteState).toEqual("AlwaysON");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Vault");

      // In-place: public access, identity, soft-delete retention, tags.
      const updated = yield* stack.deploy(
        program({
          location,
          publicNetworkAccess: "Disabled",
          identity: { type: "SystemAssigned" },
          retentionPeriodInDays: 30,
          tags: { env: "prod" },
        }),
      );
      expect(updated.vault.vaultName).toEqual(vault.vaultName);
      expect(updated.vault.principalId).toBeDefined();
      expect(updated.vault.identityType).toEqual("SystemAssigned");
      const reobserved = yield* getVault(
        group.resourceGroupName,
        vault.vaultName,
      );
      expect(reobserved.properties?.publicNetworkAccess).toEqual("Disabled");
      expect(reobserved.identity?.principalId).toEqual(
        updated.vault.principalId,
      );
      expect(
        reobserved.properties?.securitySettings?.softDeleteSettings
          ?.softDeleteRetentionPeriodInDays,
      ).toEqual(30);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: a new location creates a new vault and deletes the old.
      const replaced = yield* stack.deploy(
        program({
          location: "westus2",
          publicNetworkAccess: "Disabled",
          identity: { type: "SystemAssigned" },
          retentionPeriodInDays: 30,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.vault.location).toEqual("westus2");
      expect(replaced.vault.vaultId).not.toEqual(updated.vault.vaultId);
      const moved = yield* getVault(
        group.resourceGroupName,
        replaced.vault.vaultName,
      );
      expect(moved.location).toEqual("westus2");

      yield* stack.destroy();

      expect(
        yield* waitGone(
          getVault(group.resourceGroupName, replaced.vault.vaultName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
