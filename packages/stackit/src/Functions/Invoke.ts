import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { HttpClientError } from "effect/http/HttpClientError";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { HttpMethod } from "effect/http/HttpMethod";
import type { Function } from "./Function.ts";

export interface InvokeRequest {
  /**
   * Path and query, appended to the function's URL.
   *
   * @default "/"
   */
  readonly path?: string;
  /**
   * HTTP method.
   *
   * @default "GET"
   */
  readonly method?: HttpMethod;
  /** Request headers. */
  readonly headers?: Record<string, string>;
  /** Request body. */
  readonly body?: string;
}

/** The bound function has no URL to call: the API reported none. */
export class FunctionUrlMissing extends Data.TaggedError("Stackit.Functions.FunctionUrlMissing")<{
  readonly functionName: string;
  readonly message: string;
}> {}

/**
 * Call a deployed `Stackit.Functions.Function` over its URL.
 *
 * Bind it to a {@link Function} in a Function/Worker init phase and provide
 * {@link InvokeHttp}. The function's URL reaches the host's env when the host
 * deploys. Nothing is granted, no service account is created, and the request
 * carries only the headers you pass.
 *
 * ### Calling a Function
 * **Example:** Call a function from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Backend = Stackit.Functions.Function("Backend", {
 *   image: "ghcr.io/my-org/backend:v1.0.0",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const backend = yield* Backend;
 *     const invoke = yield* Stackit.Functions.Invoke(backend);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const response = yield* invoke({ path: "/orders" });
 *         return yield* HttpServerResponse.text(yield* response.text);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Functions.InvokeHttp)),
 * ) {}
 * ```
 *
 * **Example:** Send a JSON body
 * ```typescript
 * const response = yield* invoke({
 *   path: "/orders",
 *   method: "POST",
 *   headers: { "content-type": "application/json" },
 *   body: JSON.stringify({ sku: "abc" }),
 * });
 * ```
 *
 * @binding
 * @category Functions
 */
export interface Invoke extends Binding.Service<
  Invoke,
  "Stackit.Functions.Invoke",
  (
    fn: Function<any>,
  ) => Effect.Effect<
    (
      request?: InvokeRequest,
    ) => Effect.Effect<
      HttpClientResponse.HttpClientResponse,
      HttpClientError | FunctionUrlMissing,
      RuntimeContext
    >
  >
> {}

export const Invoke = Binding.Service<Invoke>("Stackit.Functions.Invoke");
