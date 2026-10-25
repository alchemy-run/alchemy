import type * as weather from "@distilled.cloud/azure/maps-weather";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetHourlyForecast` request; the bound account supplies `x-ms-client-id`. */
export interface GetHourlyForecastRequest extends Omit<
  weather.GetWeatherHourlyForecastRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetHourlyForecast}. */
export type GetHourlyForecastClient = (
  request: GetHourlyForecastRequest,
) => Effect.Effect<
  weather.HourlyForecastResult,
  weather.GetWeatherHourlyForecastError,
  RuntimeContext
>;

/**
 * Get hourly weather forecasts for up to 240 hours. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetHourlyForecastHttp}.
 *
 * ### Calling GetHourlyForecast
 * **Example:** GetHourlyForecast from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsWeatherReadRole on the account
 *     const getHourlyForecast = yield* Azure.Maps.GetHourlyForecast(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { forecasts } = yield* getHourlyForecast({ format: "json", query: "47.632346,-122.13887", duration: 12 });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetHourlyForecastHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetHourlyForecast extends Binding.Service<
  GetHourlyForecast,
  "Azure.Maps.GetHourlyForecast",
  (account: Account) => Effect.Effect<GetHourlyForecastClient>
> {}

export const GetHourlyForecast = Binding.Service<GetHourlyForecast>("Azure.Maps.GetHourlyForecast");
