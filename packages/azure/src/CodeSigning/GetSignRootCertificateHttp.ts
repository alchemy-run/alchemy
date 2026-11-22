import * as sign from "@distilled.cloud/azure/artifactsigning-data";
import * as Layer from "effect/Layer";
import { makeCertificateProfileHttpBinding } from "./BindingHttp.ts";
import { GetSignRootCertificate } from "./GetSignRootCertificate.ts";

/**
 * Implementation of {@link GetSignRootCertificate} over the distilled
 * `artifactsigning-data` data plane. Assigns the custom
 * `AzureCodeSigningSignRole` on the certificate profile.
 *
 * @layer
 * @provides Azure.CodeSigning.GetSignRootCertificate
 */
export const GetSignRootCertificateHttp = Layer.effect(
  GetSignRootCertificate,
  makeCertificateProfileHttpBinding({
    tag: "Azure.CodeSigning.GetSignRootCertificate",
    operation: sign.CertificateProfileOperationsGetSignRootCertificate,
  }),
);
