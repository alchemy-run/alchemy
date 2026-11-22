import type * as render from "@distilled.cloud/azure/maps-render";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetMapStaticImage` request; the bound account supplies `x-ms-client-id`. */
export interface GetMapStaticImageRequest extends Omit<
  render.GetRenderMapStaticImageRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetMapStaticImage}. */
export type GetMapStaticImageClient = (
  request: GetMapStaticImageRequest,
) => Effect.Effect<
  render.GetRenderMapStaticImageResponse,
  render.GetRenderMapStaticImageError,
  RuntimeContext
>;

/**
 * Render a static map image (`body` is the PNG bytes). Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetMapStaticImageHttp}.
 *
 * ### Calling GetMapStaticImage
 * **Example:** GetMapStaticImage from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsRenderReadRole on the account
 *     const getMapStaticImage = yield* Azure.Maps.GetMapStaticImage(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { body } = yield* getMapStaticImage({
 *   tilesetId: "microsoft.base.road",
 *   zoom: 12,
 *   center: "-122.177621,47.613079",
 *   width: 256,
 *   height: 256,
 * });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetMapStaticImageHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetMapStaticImage extends Binding.Service<
  GetMapStaticImage,
  "Azure.Maps.GetMapStaticImage",
  (account: Account) => Effect.Effect<GetMapStaticImageClient>
> {}

export const GetMapStaticImage = Binding.Service<GetMapStaticImage>("Azure.Maps.GetMapStaticImage");
