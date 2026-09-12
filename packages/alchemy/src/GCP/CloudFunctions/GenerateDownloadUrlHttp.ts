import * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import * as Layer from "effect/Layer";
import { makeFunctionHttpBinding } from "./BindingHttp.ts";
import { GenerateDownloadUrl } from "./GenerateDownloadUrl.ts";

/**
 * HTTP implementation of {@link GenerateDownloadUrl}.
 *
 * @layer
 * @provides GCP.CloudFunctions.GenerateDownloadUrl
 */
export const GenerateDownloadUrlHttp = Layer.effect(
  GenerateDownloadUrl,
  makeFunctionHttpBinding({
    tag: "GCP.CloudFunctions.GenerateDownloadUrl",
    operation: cloudfunctions.generateDownloadUrlProjectsLocationsFunctions,
  }),
);
