import type * as route from "@distilled.cloud/azure/maps-route";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetRouteOperationResult` request; the bound account supplies `x-ms-client-id`. */
export interface GetRouteOperationResultRequest extends Omit<
  route.GetRouteRouteOperationsResultRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetRouteOperationResult}. */
export type GetRouteOperationResultClient = (
  request: GetRouteOperationResultRequest,
) => Effect.Effect<
  route.RouteOperationResponse,
  route.GetRouteRouteOperationsResultError,
  RuntimeContext
>;

/**
 * Get the result of a finished asynchronous route job. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetRouteOperationResultHttp}.
 *
 * ### Calling GetRouteOperationResult
 * **Example:** GetRouteOperationResult from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsRouteReadRole on the account
 *     const getRouteOperationResult = yield* Azure.Maps.GetRouteOperationResult(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const result = yield* getRouteOperationResult({ id });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetRouteOperationResultHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetRouteOperationResult extends Binding.Service<
  GetRouteOperationResult,
  "Azure.Maps.GetRouteOperationResult",
  (account: Account) => Effect.Effect<GetRouteOperationResultClient>
> {}

export const GetRouteOperationResult = Binding.Service<GetRouteOperationResult>(
  "Azure.Maps.GetRouteOperationResult",
);
