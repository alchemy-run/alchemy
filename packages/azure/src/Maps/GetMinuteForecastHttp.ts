import * as weather from "@distilled.cloud/azure/maps-weather";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetMinuteForecast } from "./GetMinuteForecast.ts";

/**
 * Implementation of {@link GetMinuteForecast} over the distilled `maps-weather` data
 * plane. Assigns the custom `AzureMapsWeatherReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetMinuteForecast
 */
export const GetMinuteForecastHttp = Layer.effect(
  GetMinuteForecast,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetMinuteForecast",
    operation: weather.GetWeatherMinuteForecast,
    grants: [MapsRole.WeatherRead],
  }),
);
