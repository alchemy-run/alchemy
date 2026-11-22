import * as weather from "@distilled.cloud/azure/maps-weather";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetDailyHistoricalRecords } from "./GetDailyHistoricalRecords.ts";

/**
 * Implementation of {@link GetDailyHistoricalRecords} over the distilled `maps-weather` data
 * plane. Assigns the custom `AzureMapsWeatherReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetDailyHistoricalRecords
 */
export const GetDailyHistoricalRecordsHttp = Layer.effect(
  GetDailyHistoricalRecords,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetDailyHistoricalRecords",
    operation: weather.GetWeatherDailyHistoricalRecords,
    grants: [MapsRole.WeatherRead],
  }),
);
