import * as sign from "@distilled.cloud/azure/artifactsigning-data";
import * as Layer from "effect/Layer";
import { makeCertificateProfileListHttpBinding } from "./BindingHttp.ts";
import { ListExtendedKeyUsages } from "./ListExtendedKeyUsages.ts";

/**
 * Implementation of {@link ListExtendedKeyUsages} over the distilled
 * `artifactsigning-data` data plane. Assigns the custom
 * `AzureCodeSigningSignRole` on the certificate profile.
 *
 * @layer
 * @provides Azure.CodeSigning.ListExtendedKeyUsages
 */
export const ListExtendedKeyUsagesHttp = Layer.effect(
  ListExtendedKeyUsages,
  makeCertificateProfileListHttpBinding({
    tag: "Azure.CodeSigning.ListExtendedKeyUsages",
    operation: sign.ListCertificateProfileOperationExtendedKeyUsages,
  }),
);
