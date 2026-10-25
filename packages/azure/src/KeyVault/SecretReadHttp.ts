import * as Layer from "effect/Layer";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import { makeReadSecretClient, makeSecretLevelBinding } from "./SecretBindingHttp.ts";
import { SecretRead } from "./SecretRead.ts";

/**
 * Implementation of {@link SecretRead} over the distilled
 * `keyvault-secrets` data plane. Assigns **Key Vault Secrets User** on the
 * secret.
 *
 * @layer
 * @provides Azure.KeyVault.SecretRead
 */
export const SecretReadHttp = Layer.effect(
  SecretRead,
  makeSecretLevelBinding({
    tag: "Azure.KeyVault.SecretRead",
    grants: [{ builtIn: BuiltInRole.KeyVaultSecretsUser }],
    makeClient: makeReadSecretClient,
  }),
);
