import type * as route from "@distilled.cloud/azure/maps-route";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetRouteOperationStatus` request; the bound account supplies `x-ms-client-id`. */
export interface GetRouteOperationStatusRequest extends Omit<
  route.GetRouteRouteOperationsStatusRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetRouteOperationStatus}. */
export type GetRouteOperationStatusClient = (
  request: GetRouteOperationStatusRequest,
) => Effect.Effect<route.RouteOperation, route.GetRouteRouteOperationsStatusError, RuntimeContext>;

/**
 * Get the status of an asynchronous route job (`StartRouteMatrix`). Calls Azure Maps from any host with Microsoft Entra ID,
 * sending the bound account's unique ID as `x-ms-client-id`.
 *
 * Binding assigns a custom role (`AzureMapsRouteReadRole`, one per stack)
 * with exactly the data action `Microsoft.Maps/accounts/services/route/read`, on the
 * account only. The built-in **Azure Maps Data Reader** grants every Maps
 * service.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link GetRouteOperationStatusHttp}.
 *
 * ### Calling GetRouteOperationStatus
 * **Example:** GetRouteOperationStatus from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsRouteReadRole on the account
 *     const getRouteOperationStatus = yield* Azure.Maps.GetRouteOperationStatus(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { status, result } = yield* getRouteOperationStatus({ id });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetRouteOperationStatusHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetRouteOperationStatus extends Binding.Service<
  GetRouteOperationStatus,
  "Azure.Maps.GetRouteOperationStatus",
  (account: Account) => Effect.Effect<GetRouteOperationStatusClient>
> {}

export const GetRouteOperationStatus = Binding.Service<GetRouteOperationStatus>(
  "Azure.Maps.GetRouteOperationStatus",
);
