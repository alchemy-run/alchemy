import * as render from "@distilled.cloud/azure/maps-render";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetCopyrightForWorld } from "./GetCopyrightForWorld.ts";

/**
 * Implementation of {@link GetCopyrightForWorld} over the distilled `maps-render` data
 * plane. Assigns the custom `AzureMapsRenderReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetCopyrightForWorld
 */
export const GetCopyrightForWorldHttp = Layer.effect(
  GetCopyrightForWorld,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetCopyrightForWorld",
    operation: render.GetRenderCopyrightForWorld,
    grants: [MapsRole.RenderRead],
  }),
);
