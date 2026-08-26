import type * as placeactions from "@distilled.cloud/gcp/mybusinessplaceactions_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { PlaceActionLink } from "./PlaceActionLink.ts";

export interface GetPlaceActionLinkRequest extends Omit<
  placeactions.GetLocationsPlaceActionLinksRequest,
  "name"
> {}

/**
 * Runtime binding for My Business Place Actions
 * `locations.placeActionLinks.get`.
 *
 * Bind this operation to a {@link PlaceActionLink} in a Function/Action
 * init phase. Provide {@link GetPlaceActionLinkHttp}.
 *
 * ### Reading Place Action Links
 * **Example:** Read a place action link
 * ```typescript
 * const getLink = yield* GCP.Mybusinessplaceactions.GetPlaceActionLink(link);
 * const current = yield* getLink({});
 * ```
 *
 * @binding
 * @product GCP
 * @category Mybusinessplaceactions
 */
export interface GetPlaceActionLink extends Binding.Service<
  GetPlaceActionLink,
  "GCP.Mybusinessplaceactions.GetPlaceActionLink",
  (
    link: PlaceActionLink,
  ) => Effect.Effect<
    (
      request: GetPlaceActionLinkRequest,
    ) => Effect.Effect<
      placeactions.PlaceActionLink,
      placeactions.GetLocationsPlaceActionLinksError,
      RuntimeContext
    >
  >
> {}

export const GetPlaceActionLink = Binding.Service<GetPlaceActionLink>(
  "GCP.Mybusinessplaceactions.GetPlaceActionLink",
);
