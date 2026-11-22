import * as weather from "@distilled.cloud/azure/maps-weather";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { SearchTropicalStorms } from "./SearchTropicalStorms.ts";

/**
 * Implementation of {@link SearchTropicalStorms} over the distilled `maps-weather` data
 * plane. Assigns the custom `AzureMapsWeatherReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.SearchTropicalStorms
 */
export const SearchTropicalStormsHttp = Layer.effect(
  SearchTropicalStorms,
  makeMapsOperationBinding({
    tag: "Azure.Maps.SearchTropicalStorms",
    operation: weather.WeatherGetTropicalStormSearch,
    grants: [MapsRole.WeatherRead],
  }),
);
