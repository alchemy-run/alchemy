import * as render from "@distilled.cloud/azure/maps-render";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetCopyrightCaption } from "./GetCopyrightCaption.ts";

/**
 * Implementation of {@link GetCopyrightCaption} over the distilled `maps-render` data
 * plane. Assigns the custom `AzureMapsRenderReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetCopyrightCaption
 */
export const GetCopyrightCaptionHttp = Layer.effect(
  GetCopyrightCaption,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetCopyrightCaption",
    operation: render.GetRenderCopyrightCaption,
    grants: [MapsRole.RenderRead],
  }),
);
