import * as weather from "@distilled.cloud/azure/maps-weather";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetDailyForecast } from "./GetDailyForecast.ts";

/**
 * Implementation of {@link GetDailyForecast} over the distilled `maps-weather` data
 * plane. Assigns the custom `AzureMapsWeatherReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetDailyForecast
 */
export const GetDailyForecastHttp = Layer.effect(
  GetDailyForecast,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetDailyForecast",
    operation: weather.GetWeatherDailyForecast,
    grants: [MapsRole.WeatherRead],
  }),
);
