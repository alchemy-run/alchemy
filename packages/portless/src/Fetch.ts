import * as Binding from "alchemy/Binding";
import { defaultProviderMode } from "alchemy/ProviderMode";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import type { Dev } from "./Dev.ts";
import { FetchDevOnly } from "./Errors.ts";
import { resolveAgainst } from "./internal/Resolve.ts";

/**
 * Calls a `Portless.Dev` service from a Worker, a Lambda function or any other
 * host. It returns a function that sends an `HttpClientRequest` to the
 * service: a relative URL resolves against the service's `origin`, an
 * absolute one is sent as it is.
 *
 * The origin reaches the host as an env value, like any attribute bound to
 * it, and the call goes through the host's `HttpClient`. A local Worker
 * trusts the Portless CA during `alchemy dev`, so the HTTPS name is verified
 * as written.
 *
 * Portless is dev-only. Binding this where a host is deployed fails with
 * `FetchDevOnly`, since a deployed runtime can't reach a name that exists on
 * a developer's machine.
 *
 * ### Calling a service from a Worker
 * **Example:** An Effect-native Worker that calls the `Api` dev service
 * ```typescript
 * import { Api } from "./Api.ts"; // a Portless.Dev
 *
 * export default class Builder extends Cloudflare.Worker<Builder>()(
 *   "Builder",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* Portless.Fetch(Api);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const response = yield* api(HttpClientRequest.get("/health"));
 *         return HttpServerResponse.text(yield* response.text);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Portless.FetchHttp)),
 * ) {}
 * ```
 *
 * ### Calling a service from a plain Worker
 * A Worker written as a plain `fetch` handler gets the origin as an env
 * value and calls it with `fetch`, no binding involved.
 *
 * **Example:** The same call without Effect
 * ```typescript
 * const worker = yield* Cloudflare.Worker("Builder", {
 *   main: "./src/worker.ts",
 *   env: { API_URL: api.origin },
 * });
 * ```
 *
 * @binding
 */
export interface Fetch extends Binding.Service<
  Fetch,
  "Portless.Fetch",
  (
    dev: Dev,
  ) => Effect.Effect<
    (
      request: HttpClientRequest.HttpClientRequest,
    ) => Effect.Effect<
      HttpClientResponse.HttpClientResponse,
      HttpClientError.RequestError,
      RuntimeContext
    >
  >
> {}

export const Fetch = Binding.Service<Fetch>("Portless.Fetch");

/**
 * Host-independent implementation: the service's origin is bound as an
 * environment value, so it works on any Platform host, and requests go
 * through the host's `HttpClient`.
 */
export const FetchHttp = Layer.effect(
  Fetch,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return Effect.fn(function* (dev: Dev) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        const mode = host?.Mode ?? (yield* defaultProviderMode);
        if (mode !== "local") {
          return yield* Effect.die(
            new FetchDevOnly({ service: dev.LogicalId, host: host?.LogicalId }),
          );
        }
      }
      // An Output becomes an env value at plan time and a value at runtime.
      const origin = yield* dev.origin;
      return (request: HttpClientRequest.HttpClientRequest) =>
        Effect.flatMap(origin, (base) => http.execute(resolveAgainst(request, base))).pipe(
          // Only a request fails here: nothing has asked for a response body yet.
          Effect.catchTag("HttpClientError", (error) => {
            const reason = error.reason;
            return reason._tag === "TransportError" ||
              reason._tag === "EncodeError" ||
              reason._tag === "InvalidUrlError"
              ? Effect.fail(reason)
              : Effect.die(error);
          }),
        );
    });
  }),
);
