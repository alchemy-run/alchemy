import * as render from "@distilled.cloud/azure/maps-render";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetCopyrightFromBoundingBox } from "./GetCopyrightFromBoundingBox.ts";

/**
 * Implementation of {@link GetCopyrightFromBoundingBox} over the distilled `maps-render` data
 * plane. Assigns the custom `AzureMapsRenderReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetCopyrightFromBoundingBox
 */
export const GetCopyrightFromBoundingBoxHttp = Layer.effect(
  GetCopyrightFromBoundingBox,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetCopyrightFromBoundingBox",
    operation: render.GetRenderCopyrightFromBoundingBox,
    grants: [MapsRole.RenderRead],
  }),
);
