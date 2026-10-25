import * as sign from "@distilled.cloud/azure/artifactsigning-data";
import * as Layer from "effect/Layer";
import { makeCertificateProfileHttpBinding } from "./BindingHttp.ts";
import { GetSigningStatus } from "./GetSigningStatus.ts";

/**
 * Implementation of {@link GetSigningStatus} over the distilled
 * `artifactsigning-data` data plane. Assigns the custom
 * `AzureCodeSigningSignRole` on the certificate profile.
 *
 * @layer
 * @provides Azure.CodeSigning.GetSigningStatus
 */
export const GetSigningStatusHttp = Layer.effect(
  GetSigningStatus,
  makeCertificateProfileHttpBinding({
    tag: "Azure.CodeSigning.GetSigningStatus",
    operation: sign.GetCertificateProfileOperationSigningStatus,
  }),
);
