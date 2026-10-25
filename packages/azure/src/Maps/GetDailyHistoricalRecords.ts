import type * as weather from "@distilled.cloud/azure/maps-weather";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetDailyHistoricalRecords` request; the bound account supplies `x-ms-client-id`. */
export interface GetDailyHistoricalRecordsRequest extends Omit<
  weather.GetWeatherDailyHistoricalRecordsRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetDailyHistoricalRecords}. */
export type GetDailyHistoricalRecordsClient = (
  request: GetDailyHistoricalRecordsRequest,
) => Effect.Effect<
  weather.DailyHistoricalRecordsResult,
  weather.GetWeatherDailyHistoricalRecordsError,
  RuntimeContext
>;

/**
 * Get the record temperatures and precipitation for a date range. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetDailyHistoricalRecordsHttp}.
 *
 * ### Calling GetDailyHistoricalRecords
 * **Example:** GetDailyHistoricalRecords from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsWeatherReadRole on the account
 *     const getDailyHistoricalRecords = yield* Azure.Maps.GetDailyHistoricalRecords(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { results } = yield* getDailyHistoricalRecords({ format: "json", query: "40.78,-77.89", startDate: "2012-01-20", endDate: "2012-01-22" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetDailyHistoricalRecordsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetDailyHistoricalRecords extends Binding.Service<
  GetDailyHistoricalRecords,
  "Azure.Maps.GetDailyHistoricalRecords",
  (account: Account) => Effect.Effect<GetDailyHistoricalRecordsClient>
> {}

export const GetDailyHistoricalRecords = Binding.Service<GetDailyHistoricalRecords>(
  "Azure.Maps.GetDailyHistoricalRecords",
);
