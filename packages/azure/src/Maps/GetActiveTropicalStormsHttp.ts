import * as weather from "@distilled.cloud/azure/maps-weather";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetActiveTropicalStorms } from "./GetActiveTropicalStorms.ts";

/**
 * Implementation of {@link GetActiveTropicalStorms} over the distilled `maps-weather` data
 * plane. Assigns the custom `AzureMapsWeatherReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetActiveTropicalStorms
 */
export const GetActiveTropicalStormsHttp = Layer.effect(
  GetActiveTropicalStorms,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetActiveTropicalStorms",
    operation: weather.GetWeatherTropicalStormActive,
    grants: [MapsRole.WeatherRead],
  }),
);
