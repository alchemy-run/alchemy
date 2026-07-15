import * as geoMaps from "@distilled.cloud/aws/geo-maps";
import * as Layer from "effect/Layer";
import { makeGeoMapsHttpBinding } from "./BindingHttp.ts";
import { GetStyleDescriptor } from "./GetStyleDescriptor.ts";

export const GetStyleDescriptorHttp = Layer.effect(
  GetStyleDescriptor,
  makeGeoMapsHttpBinding<
    geoMaps.GetStyleDescriptorRequest,
    geoMaps.GetStyleDescriptorResponse,
    geoMaps.GetStyleDescriptorError
  >({
    capability: "GetStyleDescriptor",
    iamActions: ["geo-maps:GetStyleDescriptor"],
    operation: geoMaps.getStyleDescriptor,
  }),
);
