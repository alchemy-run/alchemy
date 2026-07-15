import * as geoMaps from "@distilled.cloud/aws/geo-maps";
import * as Layer from "effect/Layer";
import { makeGeoMapsHttpBinding } from "./BindingHttp.ts";
import { GetSprites } from "./GetSprites.ts";

export const GetSpritesHttp = Layer.effect(
  GetSprites,
  makeGeoMapsHttpBinding<
    geoMaps.GetSpritesRequest,
    geoMaps.GetSpritesResponse,
    geoMaps.GetSpritesError
  >({
    capability: "GetSprites",
    iamActions: ["geo-maps:GetSprites"],
    operation: geoMaps.getSprites,
  }),
);
