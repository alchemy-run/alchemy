import type * as weather from "@distilled.cloud/azure/maps-weather";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetDailyForecast` request; the bound account supplies `x-ms-client-id`. */
export interface GetDailyForecastRequest extends Omit<
  weather.GetWeatherDailyForecastRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetDailyForecast}. */
export type GetDailyForecastClient = (
  request: GetDailyForecastRequest,
) => Effect.Effect<
  weather.DailyForecastResult,
  weather.GetWeatherDailyForecastError,
  RuntimeContext
>;

/**
 * Get daily weather forecasts for up to 45 days. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetDailyForecastHttp}.
 *
 * ### Calling GetDailyForecast
 * **Example:** GetDailyForecast from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsWeatherReadRole on the account
 *     const getDailyForecast = yield* Azure.Maps.GetDailyForecast(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { forecasts } = yield* getDailyForecast({ format: "json", query: "62.6490341,30.0734812", duration: 5 });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetDailyForecastHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetDailyForecast extends Binding.Service<
  GetDailyForecast,
  "Azure.Maps.GetDailyForecast",
  (account: Account) => Effect.Effect<GetDailyForecastClient>
> {}

export const GetDailyForecast = Binding.Service<GetDailyForecast>("Azure.Maps.GetDailyForecast");
