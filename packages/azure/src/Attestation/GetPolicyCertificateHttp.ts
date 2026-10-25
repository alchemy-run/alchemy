import * as att from "@distilled.cloud/azure/attestation-data";
import * as Layer from "effect/Layer";
import { AttestationRole, makeAttestationHttpBinding } from "./BindingHttp.ts";
import { GetPolicyCertificate } from "./GetPolicyCertificate.ts";

/**
 * Implementation of {@link GetPolicyCertificate} over the distilled
 * `attestation-data` data plane. Assigns the custom
 * `AzureAttestationPolicyReadRole` on the provider.
 *
 * @layer
 * @provides Azure.Attestation.GetPolicyCertificate
 */
export const GetPolicyCertificateHttp = Layer.effect(
  GetPolicyCertificate,
  makeAttestationHttpBinding({
    tag: "Azure.Attestation.GetPolicyCertificate",
    operation: att.GetPolicyCertificate,
    grant: AttestationRole.PolicyRead,
  }),
);
