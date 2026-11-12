import { RpcCallError } from "alchemy/Rpc";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as HttpHeaders from "effect/http/Headers";
import type { HttpClientError } from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { HttpServerError } from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as Scope from "effect/Scope";
import { AWAITING_HEADER, awaitingHeader } from "./Calls.ts";

/** A native fetch entry point: a RivetKit actor handle's `fetch`. */
export interface NativeFetcher {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
  /** Carry the WebSocket upgrade `request` asks for to the actor. */
  upgrade?(
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError, Scope.Scope>;
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
    request: HttpClientRequest.HttpClientRequest | HttpServerRequest.HttpServerRequest,
  ) =>
    Effect.gen(function* () {
      const client = HttpClientRequest.isHttpClientRequest(request);
      // A WebSocket upgrade crosses as a socket, not a request.
      if (
        !client &&
        raw.upgrade !== undefined &&
        request.headers.upgrade?.toLowerCase() === "websocket"
      ) {
        const awaiting = yield* awaitingHeader;
        return yield* Effect.scoped(
          raw.upgrade(
            awaiting === undefined
              ? request
              : request.modify({
                  headers: HttpHeaders.set(request.headers, AWAITING_HEADER, awaiting),
                }),
          ),
        );
      }
      const built = client
        ? yield* HttpClientRequest.toWeb(request).pipe(
            Effect.mapError((cause) => new RpcCallError({ method: "fetch", cause })),
          )
        : yield* HttpServerRequest.toWeb(request);
      // The sections of the calling instance waiting on this call, so a
      // call that comes back to it can fail instead of deadlocking.
      const awaiting = yield* awaitingHeader;
      let web = built;
      if (awaiting !== undefined) {
        const headers = new Headers(built.headers);
        headers.set(AWAITING_HEADER, awaiting);
        web = new Request(built, { headers });
      }
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
