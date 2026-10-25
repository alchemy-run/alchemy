import * as render from "@distilled.cloud/azure/maps-render";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetCopyrightForTile } from "./GetCopyrightForTile.ts";

/**
 * Implementation of {@link GetCopyrightForTile} over the distilled `maps-render` data
 * plane. Assigns the custom `AzureMapsRenderReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetCopyrightForTile
 */
export const GetCopyrightForTileHttp = Layer.effect(
  GetCopyrightForTile,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetCopyrightForTile",
    operation: render.GetRenderCopyrightForTile,
    grants: [MapsRole.RenderRead],
  }),
);
