import type * as weather from "@distilled.cloud/azure/maps-weather";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetAirQualityDailyForecasts` request; the bound account supplies `x-ms-client-id`. */
export interface GetAirQualityDailyForecastsRequest extends Omit<
  weather.GetWeatherAirQualityDailyForecastsRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetAirQualityDailyForecasts}. */
export type GetAirQualityDailyForecastsClient = (
  request: GetAirQualityDailyForecastsRequest,
) => Effect.Effect<
  weather.DailyAirQualityForecastResult,
  weather.GetWeatherAirQualityDailyForecastsError,
  RuntimeContext
>;

/**
 * Get daily air quality forecasts for up to 7 days. Calls Azure Maps from any host with Microsoft Entra ID,
 * sending the bound account's unique ID as `x-ms-client-id`.
 *
 * Binding assigns a custom role (`AzureMapsWeatherReadRole`, one per stack)
 * with exactly the data action `Microsoft.Maps/accounts/services/weather/read`, on the
 * account only. The built-in **Azure Maps Data Reader** grants every Maps
 * service.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link GetAirQualityDailyForecastsHttp}.
 *
 * ### Calling GetAirQualityDailyForecasts
 * **Example:** GetAirQualityDailyForecasts from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsWeatherReadRole on the account
 *     const getAirQualityDailyForecasts = yield* Azure.Maps.GetAirQualityDailyForecasts(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { results } = yield* getAirQualityDailyForecasts({ format: "json", query: "47.632346,-122.13887", duration: 1 });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetAirQualityDailyForecastsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetAirQualityDailyForecasts extends Binding.Service<
  GetAirQualityDailyForecasts,
  "Azure.Maps.GetAirQualityDailyForecasts",
  (account: Account) => Effect.Effect<GetAirQualityDailyForecastsClient>
> {}

export const GetAirQualityDailyForecasts = Binding.Service<GetAirQualityDailyForecasts>(
  "Azure.Maps.GetAirQualityDailyForecasts",
);
