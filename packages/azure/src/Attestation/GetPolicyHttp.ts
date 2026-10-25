import * as att from "@distilled.cloud/azure/attestation-data";
import * as Layer from "effect/Layer";
import { AttestationRole, makeAttestationHttpBinding } from "./BindingHttp.ts";
import { GetPolicy } from "./GetPolicy.ts";

/**
 * Implementation of {@link GetPolicy} over the distilled
 * `attestation-data` data plane. Assigns the custom
 * `AzureAttestationPolicyReadRole` on the provider.
 *
 * @layer
 * @provides Azure.Attestation.GetPolicy
 */
export const GetPolicyHttp = Layer.effect(
  GetPolicy,
  makeAttestationHttpBinding({
    tag: "Azure.Attestation.GetPolicy",
    operation: att.GetPolicy,
    grant: AttestationRole.PolicyRead,
  }),
);
