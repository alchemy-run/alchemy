import * as weather from "@distilled.cloud/azure/maps-weather";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetQuarterDayForecast } from "./GetQuarterDayForecast.ts";

/**
 * Implementation of {@link GetQuarterDayForecast} over the distilled `maps-weather` data
 * plane. Assigns the custom `AzureMapsWeatherReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetQuarterDayForecast
 */
export const GetQuarterDayForecastHttp = Layer.effect(
  GetQuarterDayForecast,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetQuarterDayForecast",
    operation: weather.GetWeatherQuarterDayForecast,
    grants: [MapsRole.WeatherRead],
  }),
);
