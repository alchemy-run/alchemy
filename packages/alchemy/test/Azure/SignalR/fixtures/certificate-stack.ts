import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { TEST_CERTIFICATE_PFX_BASE64 } from "./certificate.ts";

/**
 * Premium SignalR service with a system identity that can read a Key Vault
 * holding two copies of a certificate (the checked-in test certificate
 * unless `pfxBase64` is given).
 */
export const makeCertificateStack = (
  options: { signalRName?: string; pfxBase64?: string } = {},
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Custom certificates need Premium_P1 or higher.
    const service = yield* Azure.SignalR.SignalR("Realtime", {
      resourceGroup: group.resourceGroupName,
      name: options.signalRName,
      sku: "Premium_P1",
      identity: { type: "SystemAssigned" },
    });
    const vault = yield* Azure.KeyVault.Vault("Vault", {
      resourceGroup: group.resourceGroupName,
      softDeleteRetentionInDays: 7,
    });
    const secrets = {
      A: yield* Azure.KeyVault.Secret("CertA", {
        resourceGroup: group.resourceGroupName,
        vault: vault.vaultName,
        value: Redacted.make(options.pfxBase64 ?? TEST_CERTIFICATE_PFX_BASE64),
        contentType: "application/x-pkcs12",
      }),
      B: yield* Azure.KeyVault.Secret("CertB", {
        resourceGroup: group.resourceGroupName,
        vault: vault.vaultName,
        value: Redacted.make(options.pfxBase64 ?? TEST_CERTIFICATE_PFX_BASE64),
        contentType: "application/x-pkcs12",
      }),
    };
    const access = yield* Azure.Authorization.RoleAssignment("SignalRSecrets", {
      scope: vault.vaultId,
      roleDefinitionId: Azure.Authorization.BuiltInRole.KeyVaultSecretsUser,
      principalId: service.principalId.pipe(Output.map((id) => id ?? "")),
      principalType: "ServicePrincipal",
    });
    /** Service name that resolves only after the role assignment exists. */
    const signalRName = Output.all(
      service.signalRName,
      access.roleAssignmentId,
    ).pipe(Output.map(([name]) => name));
    return { group, service, vault, secrets, signalRName };
  });

export const certificateStack = makeCertificateStack();
