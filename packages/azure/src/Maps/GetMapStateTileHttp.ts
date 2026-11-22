import * as render from "@distilled.cloud/azure/maps-render";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetMapStateTile } from "./GetMapStateTile.ts";

/**
 * Implementation of {@link GetMapStateTile} over the distilled `maps-render` data
 * plane. Assigns the custom `AzureMapsRenderReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetMapStateTile
 */
export const GetMapStateTileHttp = Layer.effect(
  GetMapStateTile,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetMapStateTile",
    operation: render.GetRenderMapStateTile,
    grants: [MapsRole.RenderRead],
  }),
);
