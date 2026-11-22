import * as weather from "@distilled.cloud/azure/maps-weather";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetAirQualityDailyForecasts } from "./GetAirQualityDailyForecasts.ts";

/**
 * Implementation of {@link GetAirQualityDailyForecasts} over the distilled `maps-weather` data
 * plane. Assigns the custom `AzureMapsWeatherReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetAirQualityDailyForecasts
 */
export const GetAirQualityDailyForecastsHttp = Layer.effect(
  GetAirQualityDailyForecasts,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetAirQualityDailyForecasts",
    operation: weather.GetWeatherAirQualityDailyForecasts,
    grants: [MapsRole.WeatherRead],
  }),
);
