import * as weather from "@distilled.cloud/azure/maps-weather";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetCurrentAirQuality } from "./GetCurrentAirQuality.ts";

/**
 * Implementation of {@link GetCurrentAirQuality} over the distilled `maps-weather` data
 * plane. Assigns the custom `AzureMapsWeatherReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetCurrentAirQuality
 */
export const GetCurrentAirQualityHttp = Layer.effect(
  GetCurrentAirQuality,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetCurrentAirQuality",
    operation: weather.GetWeatherCurrentAirQuality,
    grants: [MapsRole.WeatherRead],
  }),
);
