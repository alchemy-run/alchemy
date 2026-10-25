import type * as weather from "@distilled.cloud/azure/maps-weather";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetSevereWeatherAlerts` request; the bound account supplies `x-ms-client-id`. */
export interface GetSevereWeatherAlertsRequest extends Omit<
  weather.GetWeatherSevereWeatherAlertsRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetSevereWeatherAlerts}. */
export type GetSevereWeatherAlertsClient = (
  request: GetSevereWeatherAlertsRequest,
) => Effect.Effect<
  weather.SevereWeatherAlertsResult,
  weather.GetWeatherSevereWeatherAlertsError,
  RuntimeContext
>;

/**
 * Get the official severe weather alerts at a coordinate. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetSevereWeatherAlertsHttp}.
 *
 * ### Calling GetSevereWeatherAlerts
 * **Example:** GetSevereWeatherAlerts from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsWeatherReadRole on the account
 *     const getSevereWeatherAlerts = yield* Azure.Maps.GetSevereWeatherAlerts(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { results } = yield* getSevereWeatherAlerts({ format: "json", query: "48.057,-81.091" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetSevereWeatherAlertsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetSevereWeatherAlerts extends Binding.Service<
  GetSevereWeatherAlerts,
  "Azure.Maps.GetSevereWeatherAlerts",
  (account: Account) => Effect.Effect<GetSevereWeatherAlertsClient>
> {}

export const GetSevereWeatherAlerts = Binding.Service<GetSevereWeatherAlerts>(
  "Azure.Maps.GetSevereWeatherAlerts",
);
