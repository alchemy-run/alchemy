import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type { HttpClientError } from "effect/unstable/http/HttpClientError";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RpcCallError } from "../Rpc.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";

/** The fetch-only native capability exposed by Celld assets and loaded Workers. */
export interface NativeFetcher {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

/** Effect HTTP access without unsupported TCP or stub-transfer operations. */
export interface Fetcher {
  readonly raw: NativeFetcher;
  fetch(
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError | HttpServerError | RpcCallError,
    RuntimeContext
  >;
  fetch(
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError | RpcCallError,
    RuntimeContext
  >;
}

/** @internal */
export const fromNativeFetcher = (raw: NativeFetcher): Fetcher => {
  const fetch = (
    request:
      | HttpClientRequest.HttpClientRequest
      | HttpServerRequest.HttpServerRequest,
  ) =>
    Effect.gen(function* () {
      const client = HttpClientRequest.isHttpClientRequest(request);
      const web = client
        ? yield* HttpClientRequest.toWeb(request).pipe(
            Effect.mapError(
              (cause) => new RpcCallError({ method: "fetch", cause }),
            ),
          )
        : yield* HttpServerRequest.toWeb(request);
      const response = yield* Effect.tryPromise({
        try: () => raw.fetch(web),
        catch: (cause) => new RpcCallError({ method: "fetch", cause }),
      });
      return client
        ? HttpClientResponse.fromWeb(request, response)
        : HttpServerResponse.fromWeb(response);
    });
  return { raw, fetch: fetch as Fetcher["fetch"] };
};

/** Direct, single-method native RPC; Celld cannot pipeline or transfer stubs. */
export type NativeRpcClient<Shape> = {
  [
    K in keyof Shape as Shape[K] extends (...args: any[]) => any ? K : never
  ]: Shape[K] extends (...args: infer Args) => infer Value
    ? (
        ...args: Args
      ) => Effect.Effect<Awaited<Value>, RpcCallError, RuntimeContext>
    : never;
};

/** @internal */
export const fromNativeRpc = <Shape>(
  raw: NativeFetcher,
): Fetcher & NativeRpcClient<Shape> =>
  new Proxy(fromNativeFetcher(raw), {
    get(target, property, receiver) {
      if (Reflect.has(target, property))
        return Reflect.get(target, property, receiver);
      if (property === "then" || typeof property !== "string") return undefined;
      return (...args: unknown[]) =>
        Effect.tryPromise({
          try: () =>
            Promise.resolve(
              Reflect.apply(Reflect.get(raw, property), raw, args),
            ),
          catch: (cause) => new RpcCallError({ method: property, cause }),
        });
    },
  }) as Fetcher & NativeRpcClient<Shape>;
