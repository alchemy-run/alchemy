import * as weather from "@distilled.cloud/azure/maps-weather";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetTropicalStormLocations } from "./GetTropicalStormLocations.ts";

/**
 * Implementation of {@link GetTropicalStormLocations} over the distilled `maps-weather` data
 * plane. Assigns the custom `AzureMapsWeatherReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetTropicalStormLocations
 */
export const GetTropicalStormLocationsHttp = Layer.effect(
  GetTropicalStormLocations,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetTropicalStormLocations",
    operation: weather.GetWeatherTropicalStormLocations,
    grants: [MapsRole.WeatherRead],
  }),
);
