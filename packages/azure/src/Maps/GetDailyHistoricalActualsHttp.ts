import * as weather from "@distilled.cloud/azure/maps-weather";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetDailyHistoricalActuals } from "./GetDailyHistoricalActuals.ts";

/**
 * Implementation of {@link GetDailyHistoricalActuals} over the distilled `maps-weather` data
 * plane. Assigns the custom `AzureMapsWeatherReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetDailyHistoricalActuals
 */
export const GetDailyHistoricalActualsHttp = Layer.effect(
  GetDailyHistoricalActuals,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetDailyHistoricalActuals",
    operation: weather.GetWeatherDailyHistoricalActuals,
    grants: [MapsRole.WeatherRead],
  }),
);
