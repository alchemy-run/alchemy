import type * as weather from "@distilled.cloud/azure/maps-weather";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetTropicalStormForecast` request; the bound account supplies `x-ms-client-id`. */
export interface GetTropicalStormForecastRequest extends Omit<
  weather.GetWeatherTropicalStormForecastRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetTropicalStormForecast}. */
export type GetTropicalStormForecastClient = (
  request: GetTropicalStormForecastRequest,
) => Effect.Effect<
  weather.StormForecastResult,
  weather.GetWeatherTropicalStormForecastError,
  RuntimeContext
>;

/**
 * Get the forecast track of a tropical storm. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetTropicalStormForecastHttp}.
 *
 * ### Calling GetTropicalStormForecast
 * **Example:** GetTropicalStormForecast from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsWeatherReadRole on the account
 *     const getTropicalStormForecast = yield* Azure.Maps.GetTropicalStormForecast(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { results } = yield* getTropicalStormForecast({ format: "json", year: 2021, basinId: "EP", govId: 13 });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetTropicalStormForecastHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetTropicalStormForecast extends Binding.Service<
  GetTropicalStormForecast,
  "Azure.Maps.GetTropicalStormForecast",
  (account: Account) => Effect.Effect<GetTropicalStormForecastClient>
> {}

export const GetTropicalStormForecast = Binding.Service<GetTropicalStormForecast>(
  "Azure.Maps.GetTropicalStormForecast",
);
