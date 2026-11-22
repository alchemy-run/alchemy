import type * as weather from "@distilled.cloud/azure/maps-weather";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetCurrentAirQuality` request; the bound account supplies `x-ms-client-id`. */
export interface GetCurrentAirQualityRequest extends Omit<
  weather.GetWeatherCurrentAirQualityRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetCurrentAirQuality}. */
export type GetCurrentAirQualityClient = (
  request: GetCurrentAirQualityRequest,
) => Effect.Effect<
  weather.AirQualityResult,
  weather.GetWeatherCurrentAirQualityError,
  RuntimeContext
>;

/**
 * Get the current air quality at a coordinate. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetCurrentAirQualityHttp}.
 *
 * ### Calling GetCurrentAirQuality
 * **Example:** GetCurrentAirQuality from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsWeatherReadRole on the account
 *     const getCurrentAirQuality = yield* Azure.Maps.GetCurrentAirQuality(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { results } = yield* getCurrentAirQuality({ format: "json", query: "47.632346,-122.13887" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetCurrentAirQualityHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetCurrentAirQuality extends Binding.Service<
  GetCurrentAirQuality,
  "Azure.Maps.GetCurrentAirQuality",
  (account: Account) => Effect.Effect<GetCurrentAirQualityClient>
> {}

export const GetCurrentAirQuality = Binding.Service<GetCurrentAirQuality>(
  "Azure.Maps.GetCurrentAirQuality",
);
