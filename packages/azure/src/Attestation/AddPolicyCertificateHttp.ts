import * as att from "@distilled.cloud/azure/attestation-data";
import * as Layer from "effect/Layer";
import { AddPolicyCertificate } from "./AddPolicyCertificate.ts";
import { AttestationRole, makeAttestationHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AddPolicyCertificate} over the distilled
 * `attestation-data` data plane. Assigns the custom
 * `AzureAttestationPolicyWriteRole` on the provider.
 *
 * @layer
 * @provides Azure.Attestation.AddPolicyCertificate
 */
export const AddPolicyCertificateHttp = Layer.effect(
  AddPolicyCertificate,
  makeAttestationHttpBinding({
    tag: "Azure.Attestation.AddPolicyCertificate",
    operation: att.AddPolicyCertificate,
    grant: AttestationRole.PolicyWrite,
  }),
);
