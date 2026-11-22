import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { WebPubSub } from "./WebPubSub.ts";

/** Runtime callable of {@link GetServiceStatus}: succeeds while the service is healthy. */
export type GetServiceStatusClient = () => Effect.Effect<
  webpubsub.GetServiceStatusResponse,
  webpubsub.GetServiceStatusError,
  RuntimeContext
>;

/**
 * Check the health of an Azure Web PubSub service (`HEAD /api/health`)
 * from any host: the call succeeds while the service is healthy.
 *
 * The health check needs no data role, so binding assigns none. On a host
 * without a managed identity (a Cloudflare Worker, an AWS Lambda) Alchemy
 * still creates the Entra service principal the call authenticates with
 * (see `AzureBindings`). Provide {@link GetServiceStatusHttp}.
 *
 * ### Calling GetServiceStatus
 * **Example:** Health probe from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: no role; binds the service's endpoint
 *     const getServiceStatus = yield* Azure.WebPubSub.GetServiceStatus(pubsub);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint is filled in
 *         yield* getServiceStatus();
 *         return HttpServerResponse.text("healthy");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.GetServiceStatusHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface GetServiceStatus extends Binding.Service<
  GetServiceStatus,
  "Azure.WebPubSub.GetServiceStatus",
  (service: WebPubSub) => Effect.Effect<GetServiceStatusClient>
> {}

export const GetServiceStatus = Binding.Service<GetServiceStatus>(
  "Azure.WebPubSub.GetServiceStatus",
);
