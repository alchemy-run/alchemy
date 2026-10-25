import * as att from "@distilled.cloud/azure/attestation-data";
import * as Layer from "effect/Layer";
import { AttestationRole, makeAttestationHttpBinding } from "./BindingHttp.ts";
import { ResetPolicy } from "./ResetPolicy.ts";

/**
 * Implementation of {@link ResetPolicy} over the distilled
 * `attestation-data` data plane. Assigns the custom
 * `AzureAttestationPolicyWriteRole` on the provider.
 *
 * @layer
 * @provides Azure.Attestation.ResetPolicy
 */
export const ResetPolicyHttp = Layer.effect(
  ResetPolicy,
  makeAttestationHttpBinding({
    tag: "Azure.Attestation.ResetPolicy",
    operation: att.ResetPolicy,
    grant: AttestationRole.PolicyWrite,
  }),
);
