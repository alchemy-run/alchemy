import * as weather from "@distilled.cloud/azure/maps-weather";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetDailyIndices } from "./GetDailyIndices.ts";

/**
 * Implementation of {@link GetDailyIndices} over the distilled `maps-weather` data
 * plane. Assigns the custom `AzureMapsWeatherReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetDailyIndices
 */
export const GetDailyIndicesHttp = Layer.effect(
  GetDailyIndices,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetDailyIndices",
    operation: weather.GetWeatherDailyIndices,
    grants: [MapsRole.WeatherRead],
  }),
);
