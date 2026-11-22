import * as weather from "@distilled.cloud/azure/maps-weather";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetWeatherAlongRoute } from "./GetWeatherAlongRoute.ts";

/**
 * Implementation of {@link GetWeatherAlongRoute} over the distilled `maps-weather` data
 * plane. Assigns the custom `AzureMapsWeatherReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetWeatherAlongRoute
 */
export const GetWeatherAlongRouteHttp = Layer.effect(
  GetWeatherAlongRoute,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetWeatherAlongRoute",
    operation: weather.GetWeatherWeatherAlongRoute,
    grants: [MapsRole.WeatherRead],
  }),
);
