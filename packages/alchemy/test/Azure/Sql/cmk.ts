import * as Azure from "@/Azure";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { sqlServer } from "./harness.ts";

/** Built-in role `Key Vault Crypto Service Encryption User`. */
const CRYPTO_SERVICE_ENCRYPTION_USER = "e147488a-f6f5-4113-8e2d-b22465e65bf6";

/**
 * A SQL server with a system-assigned identity, plus a purge-protected
 * RBAC Key Vault (required for TDE customer-managed keys) the identity
 * may wrap/unwrap keys in, and the named RSA keys.
 *
 * Purge protection keeps the deleted vault (free) for 7 days; the Vault
 * provider recovers it on the next run.
 */
export const cmkServer = (
  password: Redacted.Redacted<string>,
  keyNames: readonly string[],
) =>
  Effect.gen(function* () {
    const { group, server } = yield* sqlServer(password, {
      identity: { type: "SystemAssigned" },
    });
    const vault = yield* Azure.KeyVault.Vault("Vault", {
      resourceGroup: group.resourceGroupName,
      location: group.location,
      enableRbacAuthorization: true,
      enablePurgeProtection: true,
      softDeleteRetentionInDays: 7,
    });
    const access = yield* Azure.Authorization.RoleAssignment("VaultAccess", {
      scope: vault.vaultId,
      roleDefinitionId: CRYPTO_SERVICE_ENCRYPTION_USER,
      principalId: server.principalId.as<string>(),
      principalType: "ServicePrincipal",
    });
    const keys = yield* Effect.forEach(keyNames, (name) =>
      Azure.KeyVault.Key(name, {
        resourceGroup: group.resourceGroupName,
        vault: vault.vaultName,
        kty: "RSA",
        keySize: 2048,
      }),
    );
    return { group, server, vault, access, keys };
  });
