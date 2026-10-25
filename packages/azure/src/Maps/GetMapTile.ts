import type * as render from "@distilled.cloud/azure/maps-render";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetMapTile` request; the bound account supplies `x-ms-client-id`. */
export interface GetMapTileRequest extends Omit<render.GetRenderMapTileRequest, "xMsClientId"> {}

/** Runtime callable of {@link GetMapTile}. */
export type GetMapTileClient = (
  request: GetMapTileRequest,
) => Effect.Effect<render.GetRenderMapTileResponse, render.GetRenderMapTileError, RuntimeContext>;

/**
 * Get a map tile (`body` is the PNG, JPEG or vector tile bytes). Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetMapTileHttp}.
 *
 * ### Calling GetMapTile
 * **Example:** GetMapTile from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsRenderReadRole on the account
 *     const getMapTile = yield* Azure.Maps.GetMapTile(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { body } = yield* getMapTile({ tilesetId: "microsoft.base.road", zoom: 6, x: 10, y: 22 });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetMapTileHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetMapTile extends Binding.Service<
  GetMapTile,
  "Azure.Maps.GetMapTile",
  (account: Account) => Effect.Effect<GetMapTileClient>
> {}

export const GetMapTile = Binding.Service<GetMapTile>("Azure.Maps.GetMapTile");
