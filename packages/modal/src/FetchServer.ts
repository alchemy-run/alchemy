import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import type { Rpc } from "alchemy/Rpc";
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
 * The client {@link FetchServer} returns: `url` and `fetch`, plus the RPC
 * methods of a `Modal.Server` program (everything it returns besides
 * `fetch` and `run`).
 */
export type FetchClient<Shape> = ServerClient & Omit<Shape, "fetch" | "run" | "url">;

/**
 * Call a `Modal.Server`, a `Modal.Function` with `web`, or a model
 * `Modal.Endpoint` from any runtime. Servers and endpoints require Modal's
 * proxy auth by default: the binding creates a `Modal.WebhookToken` for the
 * host and sends its `Modal-Key` / `Modal-Secret` headers with every request.
 *
 * A `Modal.Server` program's RPC methods come back on the client too. Each
 * call is a `POST /__rpc__/<method>` to the Server through Modal's proxy,
 * with the arguments and result as JSON; a method that returns a `Stream`
 * streams. The binding gives the host its own key for the Server, which
 * every method call carries: the Server answers methods only for callers
 * bound to it. It serves them only behind proxy auth, so an
 * `unauthenticated` Server answers them with `404`.
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
 * ### Call a Server's methods
 * **Example:** RPC methods next to `fetch`
 * ```typescript
 * // src/Api.ts
 * export default class Api extends Modal.Server<Api>()(
 *   "Api",
 *   { main: import.meta.url, app: Backend },
 *   Effect.gen(function* () {
 *     return {
 *       greet: Effect.fn(function* (name: string) {
 *         return `hello ${name}`;
 *       }),
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * **Example:** Call them from a Cloudflare Worker
 * ```typescript
 * const api = yield* Modal.FetchServer(Api);
 * const greeting = yield* api.greet("modal");
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

/** FetchServer's call signatures, typed from the target's program. */
export interface FetchServerCall {
  /** A `Modal.Server` of the Stack: `url`, `fetch` and its program's RPC methods. */
  <Shape, Req = never>(
    server: (Server & Rpc<Shape>) | Effect.Effect<Server & Rpc<Shape>, never, Req>,
  ): Effect.Effect<FetchClient<Shape>, never, FetchServer | Req>;
  /** A web Function, a model Endpoint, or an async Server: `url` and `fetch`. */
  <Req = never>(
    server:
      | Input<Server | Function | Endpoint>
      | Effect.Effect<Server | Function | Endpoint, never, Req>,
  ): Effect.Effect<ServerClient, never, FetchServer | Req>;
}

export const FetchServer = Binding.Service<FetchServer>(
  "Modal.FetchServer",
) as unknown as FetchServerCall & FetchServer;
