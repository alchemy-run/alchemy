import * as siteVerification from "@distilled.cloud/gcp/siteVerification_v1";
import * as Layer from "effect/Layer";
import { makeWebResourceHttpBinding } from "./BindingHttp.ts";
import { GetWebResource } from "./GetWebResource.ts";

/**
 * HTTP implementation of {@link GetWebResource}.
 *
 * @layer
 * @provides GCP.SiteVerification.GetWebResource
 */
export const GetWebResourceHttp = Layer.effect(
  GetWebResource,
  makeWebResourceHttpBinding({
    tag: "GCP.SiteVerification.GetWebResource",
    operation: siteVerification.getWebResource,
  }),
);
