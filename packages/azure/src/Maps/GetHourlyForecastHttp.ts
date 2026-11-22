import * as weather from "@distilled.cloud/azure/maps-weather";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetHourlyForecast } from "./GetHourlyForecast.ts";

/**
 * Implementation of {@link GetHourlyForecast} over the distilled `maps-weather` data
 * plane. Assigns the custom `AzureMapsWeatherReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetHourlyForecast
 */
export const GetHourlyForecastHttp = Layer.effect(
  GetHourlyForecast,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetHourlyForecast",
    operation: weather.GetWeatherHourlyForecast,
    grants: [MapsRole.WeatherRead],
  }),
);
