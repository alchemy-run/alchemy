import * as weather from "@distilled.cloud/azure/maps-weather";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetCurrentConditions } from "./GetCurrentConditions.ts";

/**
 * Implementation of {@link GetCurrentConditions} over the distilled `maps-weather` data
 * plane. Assigns the custom `AzureMapsWeatherReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetCurrentConditions
 */
export const GetCurrentConditionsHttp = Layer.effect(
  GetCurrentConditions,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetCurrentConditions",
    operation: weather.GetWeatherCurrentConditions,
    grants: [MapsRole.WeatherRead],
  }),
);
