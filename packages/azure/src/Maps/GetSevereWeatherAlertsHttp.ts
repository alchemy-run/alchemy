import * as weather from "@distilled.cloud/azure/maps-weather";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetSevereWeatherAlerts } from "./GetSevereWeatherAlerts.ts";

/**
 * Implementation of {@link GetSevereWeatherAlerts} over the distilled `maps-weather` data
 * plane. Assigns the custom `AzureMapsWeatherReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetSevereWeatherAlerts
 */
export const GetSevereWeatherAlertsHttp = Layer.effect(
  GetSevereWeatherAlerts,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetSevereWeatherAlerts",
    operation: weather.GetWeatherSevereWeatherAlerts,
    grants: [MapsRole.WeatherRead],
  }),
);
