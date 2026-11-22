import type * as render from "@distilled.cloud/azure/maps-render";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetCopyrightCaption` request; the bound account supplies `x-ms-client-id`. */
export interface GetCopyrightCaptionRequest extends Omit<
  render.GetRenderCopyrightCaptionRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetCopyrightCaption}. */
export type GetCopyrightCaptionClient = (
  request: GetCopyrightCaptionRequest,
) => Effect.Effect<render.CopyrightCaption, render.GetRenderCopyrightCaptionError, RuntimeContext>;

/**
 * Get the copyright caption to show with Render tiles. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetCopyrightCaptionHttp}.
 *
 * ### Calling GetCopyrightCaption
 * **Example:** GetCopyrightCaption from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsRenderReadRole on the account
 *     const getCopyrightCaption = yield* Azure.Maps.GetCopyrightCaption(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { copyrightsCaption } = yield* getCopyrightCaption({ format: "json" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetCopyrightCaptionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetCopyrightCaption extends Binding.Service<
  GetCopyrightCaption,
  "Azure.Maps.GetCopyrightCaption",
  (account: Account) => Effect.Effect<GetCopyrightCaptionClient>
> {}

export const GetCopyrightCaption = Binding.Service<GetCopyrightCaption>(
  "Azure.Maps.GetCopyrightCaption",
);
