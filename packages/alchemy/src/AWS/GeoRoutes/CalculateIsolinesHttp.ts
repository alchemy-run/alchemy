import * as geoRoutes from "@distilled.cloud/aws/geo-routes";
import * as Layer from "effect/Layer";
import { makeGeoRoutesHttpBinding } from "./BindingHttp.ts";
import { CalculateIsolines } from "./CalculateIsolines.ts";

export const CalculateIsolinesHttp = Layer.effect(
  CalculateIsolines,
  makeGeoRoutesHttpBinding<
    geoRoutes.CalculateIsolinesRequest,
    geoRoutes.CalculateIsolinesResponse,
    geoRoutes.CalculateIsolinesError
  >({
    capability: "CalculateIsolines",
    iamActions: ["geo-routes:CalculateIsolines"],
    operation: geoRoutes.calculateIsolines,
  }),
);
