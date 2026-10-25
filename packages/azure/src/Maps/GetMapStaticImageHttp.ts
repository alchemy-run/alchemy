import * as render from "@distilled.cloud/azure/maps-render";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetMapStaticImage } from "./GetMapStaticImage.ts";

/**
 * Implementation of {@link GetMapStaticImage} over the distilled `maps-render` data
 * plane. Assigns the custom `AzureMapsRenderReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetMapStaticImage
 */
export const GetMapStaticImageHttp = Layer.effect(
  GetMapStaticImage,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetMapStaticImage",
    operation: render.GetRenderMapStaticImage,
    grants: [MapsRole.RenderRead],
  }),
);
