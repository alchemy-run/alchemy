import type * as weather from "@distilled.cloud/azure/maps-weather";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetDailyIndices` request; the bound account supplies `x-ms-client-id`. */
export interface GetDailyIndicesRequest extends Omit<
  weather.GetWeatherDailyIndicesRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetDailyIndices}. */
export type GetDailyIndicesClient = (
  request: GetDailyIndicesRequest,
) => Effect.Effect<weather.DailyIndicesResult, weather.GetWeatherDailyIndicesError, RuntimeContext>;

/**
 * Get daily weather indices (e.g. running, jogging, allergies) for up to 15 days. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetDailyIndicesHttp}.
 *
 * ### Calling GetDailyIndices
 * **Example:** GetDailyIndices from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsWeatherReadRole on the account
 *     const getDailyIndices = yield* Azure.Maps.GetDailyIndices(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { results } = yield* getDailyIndices({ format: "json", query: "43.84745,-79.37849", indexGroupId: 11 });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetDailyIndicesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetDailyIndices extends Binding.Service<
  GetDailyIndices,
  "Azure.Maps.GetDailyIndices",
  (account: Account) => Effect.Effect<GetDailyIndicesClient>
> {}

export const GetDailyIndices = Binding.Service<GetDailyIndices>("Azure.Maps.GetDailyIndices");
