import type * as weather from "@distilled.cloud/azure/maps-weather";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetDailyHistoricalNormals` request; the bound account supplies `x-ms-client-id`. */
export interface GetDailyHistoricalNormalsRequest extends Omit<
  weather.GetWeatherDailyHistoricalNormalsRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetDailyHistoricalNormals}. */
export type GetDailyHistoricalNormalsClient = (
  request: GetDailyHistoricalNormalsRequest,
) => Effect.Effect<
  weather.DailyHistoricalNormalsResult,
  weather.GetWeatherDailyHistoricalNormalsError,
  RuntimeContext
>;

/**
 * Get the 30-year climatological normals for a date range. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetDailyHistoricalNormalsHttp}.
 *
 * ### Calling GetDailyHistoricalNormals
 * **Example:** GetDailyHistoricalNormals from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsWeatherReadRole on the account
 *     const getDailyHistoricalNormals = yield* Azure.Maps.GetDailyHistoricalNormals(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { results } = yield* getDailyHistoricalNormals({ format: "json", query: "40.78,-77.89", startDate: "2012-01-20", endDate: "2012-01-22" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetDailyHistoricalNormalsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetDailyHistoricalNormals extends Binding.Service<
  GetDailyHistoricalNormals,
  "Azure.Maps.GetDailyHistoricalNormals",
  (account: Account) => Effect.Effect<GetDailyHistoricalNormalsClient>
> {}

export const GetDailyHistoricalNormals = Binding.Service<GetDailyHistoricalNormals>(
  "Azure.Maps.GetDailyHistoricalNormals",
);
