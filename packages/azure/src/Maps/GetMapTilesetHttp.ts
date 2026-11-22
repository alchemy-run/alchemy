import * as render from "@distilled.cloud/azure/maps-render";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetMapTileset } from "./GetMapTileset.ts";

/**
 * Implementation of {@link GetMapTileset} over the distilled `maps-render` data
 * plane. Assigns the custom `AzureMapsRenderReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetMapTileset
 */
export const GetMapTilesetHttp = Layer.effect(
  GetMapTileset,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetMapTileset",
    operation: render.GetRenderMapTileset,
    grants: [MapsRole.RenderRead],
  }),
);
