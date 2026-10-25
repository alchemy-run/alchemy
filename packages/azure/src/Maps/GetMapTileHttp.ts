import * as render from "@distilled.cloud/azure/maps-render";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetMapTile } from "./GetMapTile.ts";

/**
 * Implementation of {@link GetMapTile} over the distilled `maps-render` data
 * plane. Assigns the custom `AzureMapsRenderReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetMapTile
 */
export const GetMapTileHttp = Layer.effect(
  GetMapTile,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetMapTile",
    operation: render.GetRenderMapTile,
    grants: [MapsRole.RenderRead],
  }),
);
