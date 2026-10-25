import type * as timezone from "@distilled.cloud/azure/maps-timezone";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetTimezoneByCoordinates` request; the bound account supplies `x-ms-client-id`. */
export interface GetTimezoneByCoordinatesRequest extends Omit<
  timezone.GetTimezoneTimezoneByCoordinatesRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetTimezoneByCoordinates}. */
export type GetTimezoneByCoordinatesClient = (
  request: GetTimezoneByCoordinatesRequest,
) => Effect.Effect<
  timezone.TimezoneResult,
  timezone.GetTimezoneTimezoneByCoordinatesError,
  RuntimeContext
>;

/**
 * Get the time zone (and its current offset) at a coordinate. Calls Azure Maps from any host with Microsoft Entra ID,
 * sending the bound account's unique ID as `x-ms-client-id`.
 *
 * Binding assigns a custom role (`AzureMapsTimezoneReadRole`, one per stack)
 * with exactly the data action `Microsoft.Maps/accounts/services/timezone/read`, on the
 * account only. The built-in **Azure Maps Data Reader** grants every Maps
 * service.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link GetTimezoneByCoordinatesHttp}.
 *
 * ### Calling GetTimezoneByCoordinates
 * **Example:** GetTimezoneByCoordinates from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsTimezoneReadRole on the account
 *     const getTimezoneByCoordinates = yield* Azure.Maps.GetTimezoneByCoordinates(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { timeZones } = yield* getTimezoneByCoordinates({ format: "json", query: "47.0,-122.0" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetTimezoneByCoordinatesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetTimezoneByCoordinates extends Binding.Service<
  GetTimezoneByCoordinates,
  "Azure.Maps.GetTimezoneByCoordinates",
  (account: Account) => Effect.Effect<GetTimezoneByCoordinatesClient>
> {}

export const GetTimezoneByCoordinates = Binding.Service<GetTimezoneByCoordinates>(
  "Azure.Maps.GetTimezoneByCoordinates",
);
