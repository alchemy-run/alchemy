import type * as weather from "@distilled.cloud/azure/maps-weather";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetCurrentConditions` request; the bound account supplies `x-ms-client-id`. */
export interface GetCurrentConditionsRequest extends Omit<
  weather.GetWeatherCurrentConditionsRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetCurrentConditions}. */
export type GetCurrentConditionsClient = (
  request: GetCurrentConditionsRequest,
) => Effect.Effect<
  weather.CurrentConditionsResult,
  weather.GetWeatherCurrentConditionsError,
  RuntimeContext
>;

/**
 * Get the current weather conditions at a coordinate. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetCurrentConditionsHttp}.
 *
 * ### Calling GetCurrentConditions
 * **Example:** GetCurrentConditions from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsWeatherReadRole on the account
 *     const getCurrentConditions = yield* Azure.Maps.GetCurrentConditions(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { results } = yield* getCurrentConditions({ format: "json", query: "47.641268,-122.125679" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetCurrentConditionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetCurrentConditions extends Binding.Service<
  GetCurrentConditions,
  "Azure.Maps.GetCurrentConditions",
  (account: Account) => Effect.Effect<GetCurrentConditionsClient>
> {}

export const GetCurrentConditions = Binding.Service<GetCurrentConditions>(
  "Azure.Maps.GetCurrentConditions",
);
