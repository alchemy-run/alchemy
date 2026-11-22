import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";
import { UpdateKeyRotationPolicy } from "./UpdateKeyRotationPolicy.ts";

/** Builds the {@link UpdateKeyRotationPolicy} client for one key (the UpdateKeyRotationPolicyHttp implementation). */
export const makeUpdateKeyRotationPolicyClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.UpdateKeyRotationPolicy",
  operation: keys.UpdateKeyRotationPolicy,
  role: KeyRoles.WriteRotationPolicy,
});

/**
 * Implementation of {@link UpdateKeyRotationPolicy} over the distilled
 * `keyvault-keys` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keyrotationpolicies/write` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.UpdateKeyRotationPolicy
 */
export const UpdateKeyRotationPolicyHttp = Layer.effect(
  UpdateKeyRotationPolicy,
  makeUpdateKeyRotationPolicyClient,
);
