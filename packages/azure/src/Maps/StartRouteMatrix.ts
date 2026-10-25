import type * as route from "@distilled.cloud/azure/maps-route";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `StartRouteMatrix` request; the bound account supplies `x-ms-client-id`. */
export interface StartRouteMatrixRequest extends Omit<
  route.PostRouteRouteMatrixAsyncRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link StartRouteMatrix}. */
export type StartRouteMatrixClient = (
  request: StartRouteMatrixRequest,
) => Effect.Effect<
  route.PostRouteRouteMatrixAsyncResponse,
  route.PostRouteRouteMatrixAsyncError,
  RuntimeContext
>;

/**
 * Start an asynchronous route matrix job; poll it with `GetRouteOperationStatus`. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link StartRouteMatrixHttp}.
 *
 * ### Calling StartRouteMatrix
 * **Example:** StartRouteMatrix from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsRouteReadRole on the account
 *     const startRouteMatrix = yield* Azure.Maps.StartRouteMatrix(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { operationLocation } = yield* startRouteMatrix({ type: "FeatureCollection", features, travelMode: "driving" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.StartRouteMatrixHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface StartRouteMatrix extends Binding.Service<
  StartRouteMatrix,
  "Azure.Maps.StartRouteMatrix",
  (account: Account) => Effect.Effect<StartRouteMatrixClient>
> {}

export const StartRouteMatrix = Binding.Service<StartRouteMatrix>("Azure.Maps.StartRouteMatrix");
