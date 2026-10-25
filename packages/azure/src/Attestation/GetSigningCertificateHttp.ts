import * as att from "@distilled.cloud/azure/attestation-data";
import * as Layer from "effect/Layer";
import { makeAttestationHttpBinding } from "./BindingHttp.ts";
import { GetSigningCertificate } from "./GetSigningCertificate.ts";

/**
 * Implementation of {@link GetSigningCertificate} over the distilled
 * `attestation-data` data plane. Assigns no role (the endpoint is
 * anonymous).
 *
 * @layer
 * @provides Azure.Attestation.GetSigningCertificate
 */
export const GetSigningCertificateHttp = Layer.effect(
  GetSigningCertificate,
  makeAttestationHttpBinding({
    tag: "Azure.Attestation.GetSigningCertificate",
    operation: att.GetSigningCertificate,
    grant: undefined,
  }),
);
