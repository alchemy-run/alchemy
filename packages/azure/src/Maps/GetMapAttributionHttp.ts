import * as render from "@distilled.cloud/azure/maps-render";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetMapAttribution } from "./GetMapAttribution.ts";

/**
 * Implementation of {@link GetMapAttribution} over the distilled `maps-render` data
 * plane. Assigns the custom `AzureMapsRenderReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetMapAttribution
 */
export const GetMapAttributionHttp = Layer.effect(
  GetMapAttribution,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetMapAttribution",
    operation: render.GetRenderMapAttribution,
    grants: [MapsRole.RenderRead],
  }),
);
