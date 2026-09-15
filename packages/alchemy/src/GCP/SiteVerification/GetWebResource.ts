import type * as siteVerification from "@distilled.cloud/gcp/siteVerification_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { WebResource } from "./WebResource.ts";

export interface GetWebResourceRequest extends Omit<
  siteVerification.GetWebResourceRequest,
  "id"
> {}

/**
 * Runtime binding for Site Verification `webResource.get`.
 *
 * Bind this operation to a {@link WebResource} in a Function/Action
 * init phase. Provide {@link GetWebResourceHttp}.
 *
 * ### Reading Web Resources
 * **Example:** Read verified site metadata
 * ```typescript
 * const getSite = yield* GCP.SiteVerification.GetWebResource(site);
 * const metadata = yield* getSite({});
 * ```
 *
 * @binding
 * @product GCP
 * @category SiteVerification
 */
export interface GetWebResource extends Binding.Service<
  GetWebResource,
  "GCP.SiteVerification.GetWebResource",
  (
    resource: WebResource,
  ) => Effect.Effect<
    (
      request: GetWebResourceRequest,
    ) => Effect.Effect<
      siteVerification.SiteVerificationWebResourceResource,
      siteVerification.GetWebResourceError,
      RuntimeContext
    >
  >
> {}

export const GetWebResource = Binding.Service<GetWebResource>(
  "GCP.SiteVerification.GetWebResource",
);
