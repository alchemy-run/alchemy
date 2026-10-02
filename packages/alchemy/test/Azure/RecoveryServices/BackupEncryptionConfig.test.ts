import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as backup from "@distilled.cloud/azure/recoveryservicesbackup";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  createVault,
  deleteVault,
  groupOnly,
  logLevel,
  subscription,
  tags,
} from "./vault.ts";

const { test } = Test.make({ providers: Azure.providers() });

const VAULT = "alchemy-test-rsv-cmk";

/** Key Vault Crypto Service Encryption User. */
const CRYPTO_SERVICE_ENCRYPTION_USER = "e147488a-f6f5-4113-8e2d-b22465e65bf6";

const keyVault = (principalId: string) =>
  Effect.gen(function* () {
    const { group, owner } = yield* groupOnly;
    const rg = group.resourceGroupName;
    // Backup CMK requires soft delete and purge protection on the Key Vault.
    const kv = yield* Azure.KeyVault.Vault("Kv", {
      resourceGroup: rg,
      softDeleteRetentionInDays: 7,
      enablePurgeProtection: true,
    });
    const keyA = yield* Azure.KeyVault.Key("KeyA", {
      resourceGroup: rg,
      vault: kv.vaultName,
      kty: "RSA",
      keySize: 2048,
    });
    const keyB = yield* Azure.KeyVault.Key("KeyB", {
      resourceGroup: rg,
      vault: kv.vaultName,
      kty: "RSA",
      keySize: 2048,
    });
    const grant = yield* Azure.Authorization.RoleAssignment("VaultKeyAccess", {
      scope: kv.vaultId,
      roleDefinitionId: CRYPTO_SERVICE_ENCRYPTION_USER,
      principalId,
      principalType: "ServicePrincipal",
    });
    return { group, owner, kv, keyA, keyB, grant };
  });

const program = (principalId: string, key: "A" | "B") =>
  Effect.gen(function* () {
    const base = yield* keyVault(principalId);
    const config = yield* Azure.RecoveryServices.BackupEncryptionConfig("Cmk", {
      resourceGroup: base.group.resourceGroupName,
      // Depend on the role assignment so the grant exists first.
      vault: Output.map(base.grant.roleAssignmentId, () => VAULT),
      keyUri: key === "A" ? base.keyA.keyUri : base.keyB.keyUri,
    });
    return { ...base, config };
  });

const getConfig = (resourceGroupName: string) =>
  Effect.gen(function* () {
    return yield* backup.GetBackupResourceEncryptionConfig({
      subscriptionId: yield* subscription,
      resourceGroupName,
      vaultName: VAULT,
    });
  });

// Cheap (Key Vault keys cost per operation) and ~5 minutes, but leaves a
// purge-protected Key Vault in the soft-deleted state for 7 days (backup
// CMK requires purge protection, which forbids purging). Run with
// AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "encrypt a vault with a customer-managed key and rotate it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, owner } = yield* stack.deploy(groupOnly);
      const rg = group.resourceGroupName;
      const vault = yield* createVault(rg, VAULT, owner, {
        systemAssignedIdentity: true,
      });
      const principalId = vault.identity?.principalId ?? "";
      expect(principalId).not.toEqual("");

      // Create: key A.
      const created = yield* stack.deploy(program(principalId, "A"));
      expect(created.config.encryptionAtRestType).toEqual("CustomerManaged");
      const observed = yield* getConfig(rg);
      expect(observed.properties?.keyUri).toEqual(created.keyA.keyUri);

      // In-place: rotate to key B.
      const updated = yield* stack.deploy(program(principalId, "B"));
      expect(updated.config.encryptionConfigId).toEqual(
        created.config.encryptionConfigId,
      );
      expect((yield* getConfig(rg)).properties?.keyUri).toEqual(
        updated.keyB.keyUri,
      );

      // Delete leaves the (irreversible) key configured; the vault goes.
      yield* stack.deploy(keyVault(principalId));
      expect((yield* getConfig(rg)).properties?.encryptionAtRestType).toEqual(
        "CustomerManaged",
      );

      yield* deleteVault(rg, VAULT);
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
