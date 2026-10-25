import * as att from "@distilled.cloud/azure/attestation-data";
import * as Layer from "effect/Layer";
import { AttestationRole, makeAttestationHttpBinding } from "./BindingHttp.ts";
import { RemovePolicyCertificate } from "./RemovePolicyCertificate.ts";

/**
 * Implementation of {@link RemovePolicyCertificate} over the distilled
 * `attestation-data` data plane. Assigns the custom
 * `AzureAttestationPolicyWriteRole` on the provider.
 *
 * @layer
 * @provides Azure.Attestation.RemovePolicyCertificate
 */
export const RemovePolicyCertificateHttp = Layer.effect(
  RemovePolicyCertificate,
  makeAttestationHttpBinding({
    tag: "Azure.Attestation.RemovePolicyCertificate",
    operation: att.RemovePolicyCertificate,
    grant: AttestationRole.PolicyWrite,
  }),
);
