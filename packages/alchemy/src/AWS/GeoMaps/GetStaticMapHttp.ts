import * as geoMaps from "@distilled.cloud/aws/geo-maps";
import * as Layer from "effect/Layer";
import { makeGeoMapsHttpBinding } from "./BindingHttp.ts";
import { GetStaticMap } from "./GetStaticMap.ts";

export const GetStaticMapHttp = Layer.effect(
  GetStaticMap,
  makeGeoMapsHttpBinding<
    geoMaps.GetStaticMapRequest,
    geoMaps.GetStaticMapResponse,
    geoMaps.GetStaticMapError
  >({
    capability: "GetStaticMap",
    iamActions: ["geo-maps:GetStaticMap"],
    operation: geoMaps.getStaticMap,
  }),
);
