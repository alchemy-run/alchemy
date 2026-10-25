import * as weather from "@distilled.cloud/azure/maps-weather";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetTropicalStormForecast } from "./GetTropicalStormForecast.ts";

/**
 * Implementation of {@link GetTropicalStormForecast} over the distilled `maps-weather` data
 * plane. Assigns the custom `AzureMapsWeatherReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetTropicalStormForecast
 */
export const GetTropicalStormForecastHttp = Layer.effect(
  GetTropicalStormForecast,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetTropicalStormForecast",
    operation: weather.GetWeatherTropicalStormForecast,
    grants: [MapsRole.WeatherRead],
  }),
);
