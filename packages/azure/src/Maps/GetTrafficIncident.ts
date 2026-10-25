import type * as traffic from "@distilled.cloud/azure/maps-traffic";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetTrafficIncident` request; the bound account supplies `x-ms-client-id`. */
export interface GetTrafficIncidentRequest extends Omit<
  traffic.GetTrafficTrafficIncidentRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetTrafficIncident}. */
export type GetTrafficIncidentClient = (
  request: GetTrafficIncidentRequest,
) => Effect.Effect<
  traffic.TrafficIncidentResponse,
  traffic.GetTrafficTrafficIncidentError,
  RuntimeContext
>;

/**
 * Get the traffic incidents (accidents, closures, construction) in a bounding box. Calls Azure Maps from any host with Microsoft Entra ID,
 * sending the bound account's unique ID as `x-ms-client-id`.
 *
 * Binding assigns a custom role (`AzureMapsTrafficReadRole`, one per stack)
 * with exactly the data action `Microsoft.Maps/accounts/services/traffic/read`, on the
 * account only. The built-in **Azure Maps Data Reader** grants every Maps
 * service.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link GetTrafficIncidentHttp}.
 *
 * ### Calling GetTrafficIncident
 * **Example:** GetTrafficIncident from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsTrafficReadRole on the account
 *     const getTrafficIncident = yield* Azure.Maps.GetTrafficIncident(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { features } = yield* getTrafficIncident({ bbox: "-122.22,47.44,-122.19,47.61" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetTrafficIncidentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetTrafficIncident extends Binding.Service<
  GetTrafficIncident,
  "Azure.Maps.GetTrafficIncident",
  (account: Account) => Effect.Effect<GetTrafficIncidentClient>
> {}

export const GetTrafficIncident = Binding.Service<GetTrafficIncident>(
  "Azure.Maps.GetTrafficIncident",
);
