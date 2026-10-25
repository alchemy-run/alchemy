import type * as render from "@distilled.cloud/azure/maps-render";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetMapStateTile` request; the bound account supplies `x-ms-client-id`. */
export interface GetMapStateTileRequest extends Omit<
  render.GetRenderMapStateTileRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetMapStateTile}. */
export type GetMapStateTileClient = (
  request: GetMapStateTileRequest,
) => Effect.Effect<
  render.GetRenderMapStateTileResponse,
  render.GetRenderMapStateTileError,
  RuntimeContext
>;

/**
 * Get a vector state tile of a Creator stateset (`body` is the tile bytes). Calls Azure Maps from any host with Microsoft Entra ID,
 * sending the bound account's unique ID as `x-ms-client-id`.
 *
 * Binding assigns a custom role (`AzureMapsRenderReadRole`, one per stack)
 * with exactly the data action `Microsoft.Maps/accounts/services/render/read`, on the
 * account only. The built-in **Azure Maps Data Reader** grants every Maps
 * service.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link GetMapStateTileHttp}.
 *
 * ### Calling GetMapStateTile
 * **Example:** GetMapStateTile from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsRenderReadRole on the account
 *     const getMapStateTile = yield* Azure.Maps.GetMapStateTile(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { body } = yield* getMapStateTile({ statesetId, zoom: 6, x: 10, y: 22 });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetMapStateTileHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetMapStateTile extends Binding.Service<
  GetMapStateTile,
  "Azure.Maps.GetMapStateTile",
  (account: Account) => Effect.Effect<GetMapStateTileClient>
> {}

export const GetMapStateTile = Binding.Service<GetMapStateTile>("Azure.Maps.GetMapStateTile");
