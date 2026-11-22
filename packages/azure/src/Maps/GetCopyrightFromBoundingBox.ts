import type * as render from "@distilled.cloud/azure/maps-render";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetCopyrightFromBoundingBox` request; the bound account supplies `x-ms-client-id`. */
export interface GetCopyrightFromBoundingBoxRequest extends Omit<
  render.GetRenderCopyrightFromBoundingBoxRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetCopyrightFromBoundingBox}. */
export type GetCopyrightFromBoundingBoxClient = (
  request: GetCopyrightFromBoundingBoxRequest,
) => Effect.Effect<render.Copyright, render.GetRenderCopyrightFromBoundingBoxError, RuntimeContext>;

/**
 * Get the copyright information of a bounding box. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetCopyrightFromBoundingBoxHttp}.
 *
 * ### Calling GetCopyrightFromBoundingBox
 * **Example:** GetCopyrightFromBoundingBox from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsRenderReadRole on the account
 *     const getCopyrightFromBoundingBox = yield* Azure.Maps.GetCopyrightFromBoundingBox(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const copyright = yield* getCopyrightFromBoundingBox({
 *   format: "json",
 *   mincoordinates: "52.41064,4.84228",
 *   maxcoordinates: "52.41072,4.84239",
 * });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetCopyrightFromBoundingBoxHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetCopyrightFromBoundingBox extends Binding.Service<
  GetCopyrightFromBoundingBox,
  "Azure.Maps.GetCopyrightFromBoundingBox",
  (account: Account) => Effect.Effect<GetCopyrightFromBoundingBoxClient>
> {}

export const GetCopyrightFromBoundingBox = Binding.Service<GetCopyrightFromBoundingBox>(
  "Azure.Maps.GetCopyrightFromBoundingBox",
);
