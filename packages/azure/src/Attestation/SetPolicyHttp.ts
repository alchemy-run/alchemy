import * as att from "@distilled.cloud/azure/attestation-data";
import * as Layer from "effect/Layer";
import { AttestationRole, makeAttestationHttpBinding } from "./BindingHttp.ts";
import { SetPolicy } from "./SetPolicy.ts";

/**
 * Implementation of {@link SetPolicy} over the distilled
 * `attestation-data` data plane. Assigns the custom
 * `AzureAttestationPolicyWriteRole` on the provider.
 *
 * @layer
 * @provides Azure.Attestation.SetPolicy
 */
export const SetPolicyHttp = Layer.effect(
  SetPolicy,
  makeAttestationHttpBinding({
    tag: "Azure.Attestation.SetPolicy",
    operation: att.SetPolicy,
    grant: AttestationRole.PolicyWrite,
  }),
);
