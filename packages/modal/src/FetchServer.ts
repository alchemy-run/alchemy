import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { Endpoint } from "./Endpoint.ts";
import type { ServerUrlMissing } from "./FetchServerHttp.ts";
import type { Function } from "./Function.ts";
import type { Server } from "./Server.ts";

/** Send requests to a deployed Modal Server, web Function or model Endpoint. */
export interface ServerClient {
  /** The server's URL. */
  readonly url: Effect.Effect<string, ServerUrlMissing, RuntimeContext>;
  /**
   * Send a request: its path and query are kept, the host is the server's,
   * and Modal's proxy auth headers are added.
   */
  fetch(
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    ServerUrlMissing | HttpClientError.HttpClientError,
    RuntimeContext
  >;
}

/**
 * Call a `Modal.Server`, a `Modal.Function` with `web`, or a model
 * `Modal.Endpoint` from any runtime. Servers and endpoints require Modal's proxy auth by default: the binding
 * creates a `Modal.WebhookToken` for the host and sends its `Modal-Key` /
 * `Modal-Secret` headers with every request.
 *
 * ### Call a Server
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as HttpClientRequest from "effect/http/HttpClientRequest";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import Api from "./Api.ts";
 *
 * export default class Gateway extends Cloudflare.Worker<Gateway>()(
 *   "Gateway",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* Modal.FetchServer(Api);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const response = yield* api.fetch(HttpClientRequest.get("/health"));
 *         return HttpServerResponse.text(yield* response.text, { status: response.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.FetchServerHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Server
 */
export interface FetchServer extends Binding.Service<
  FetchServer,
  "Modal.FetchServer",
  (server: Server | Function | Endpoint) => Effect.Effect<ServerClient>
> {}

export const FetchServer = Binding.Service<FetchServer>("Modal.FetchServer");
