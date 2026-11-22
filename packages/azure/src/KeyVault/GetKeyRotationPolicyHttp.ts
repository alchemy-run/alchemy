import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { GetKeyRotationPolicy } from "./GetKeyRotationPolicy.ts";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";

/** Builds the {@link GetKeyRotationPolicy} client for one key (the GetKeyRotationPolicyHttp implementation). */
export const makeGetKeyRotationPolicyClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.GetKeyRotationPolicy",
  operation: keys.GetKeyRotationPolicy,
  role: KeyRoles.ReadRotationPolicy,
});

/**
 * Implementation of {@link GetKeyRotationPolicy} over the distilled
 * `keyvault-keys` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keyrotationpolicies/read` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.GetKeyRotationPolicy
 */
export const GetKeyRotationPolicyHttp = Layer.effect(
  GetKeyRotationPolicy,
  makeGetKeyRotationPolicyClient,
);
