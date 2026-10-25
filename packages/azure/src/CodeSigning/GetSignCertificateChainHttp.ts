import * as sign from "@distilled.cloud/azure/artifactsigning-data";
import * as Layer from "effect/Layer";
import { makeCertificateProfileHttpBinding } from "./BindingHttp.ts";
import { GetSignCertificateChain } from "./GetSignCertificateChain.ts";

/**
 * Implementation of {@link GetSignCertificateChain} over the distilled
 * `artifactsigning-data` data plane. Assigns the custom
 * `AzureCodeSigningSignRole` on the certificate profile.
 *
 * @layer
 * @provides Azure.CodeSigning.GetSignCertificateChain
 */
export const GetSignCertificateChainHttp = Layer.effect(
  GetSignCertificateChain,
  makeCertificateProfileHttpBinding({
    tag: "Azure.CodeSigning.GetSignCertificateChain",
    operation: sign.CertificateProfileOperationsGetSignCertificateChain,
  }),
);
