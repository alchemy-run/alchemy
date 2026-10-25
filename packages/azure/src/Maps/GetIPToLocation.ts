import type * as geolocation from "@distilled.cloud/azure/maps-geolocation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetIPToLocation` request; the bound account supplies `x-ms-client-id`. */
export interface GetIPToLocationRequest extends Omit<
  geolocation.GetGeolocationIPToLocationRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetIPToLocation}. */
export type GetIPToLocationClient = (
  request: GetIPToLocationRequest,
) => Effect.Effect<
  geolocation.IpAddressToLocationResult,
  geolocation.GetGeolocationIPToLocationError,
  RuntimeContext
>;

/**
 * Look up the ISO country/region code of an IP address (IPv4 or IPv6). Calls Azure Maps from any host with Microsoft Entra ID,
 * sending the bound account's unique ID as `x-ms-client-id`.
 *
 * Binding assigns a custom role (`AzureMapsGeolocationReadRole`, one per stack)
 * with exactly the data action `Microsoft.Maps/accounts/services/geolocation/read`, on the
 * account only. The built-in **Azure Maps Data Reader** grants every Maps
 * service.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link GetIPToLocationHttp}.
 *
 * ### Calling GetIPToLocation
 * **Example:** GetIPToLocation from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsGeolocationReadRole on the account
 *     const getIPToLocation = yield* Azure.Maps.GetIPToLocation(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { countryRegion } = yield* getIPToLocation({ format: "json", ip: "8.8.8.8" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetIPToLocationHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetIPToLocation extends Binding.Service<
  GetIPToLocation,
  "Azure.Maps.GetIPToLocation",
  (account: Account) => Effect.Effect<GetIPToLocationClient>
> {}

export const GetIPToLocation = Binding.Service<GetIPToLocation>("Azure.Maps.GetIPToLocation");
