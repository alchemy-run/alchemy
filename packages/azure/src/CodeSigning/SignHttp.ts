import * as sign from "@distilled.cloud/azure/artifactsigning-data";
import * as Layer from "effect/Layer";
import { makeCertificateProfileHttpBinding } from "./BindingHttp.ts";
import { Sign } from "./Sign.ts";

/**
 * Implementation of {@link Sign} over the distilled
 * `artifactsigning-data` data plane. Assigns the custom
 * `AzureCodeSigningSignRole` on the certificate profile.
 *
 * @layer
 * @provides Azure.CodeSigning.Sign
 */
export const SignHttp = Layer.effect(
  Sign,
  makeCertificateProfileHttpBinding({
    tag: "Azure.CodeSigning.Sign",
    operation: sign.SignCertificateProfileOperation,
  }),
);
