import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import { HttpClientError } from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export interface Fetcher {
  fetch(
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError>;
  fetch(
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError>;
}

export const fromCloudflareFetcher = (fetcher: cf.Fetcher): Fetcher => {
  const fetch = (request: Request) =>
    Effect.promise((signal) =>
      fetcher.fetch(request as any as cf.Request, {
        signal: signal as cf.AbortSignal,
      }),
    );

  return {
    fetch: (
      request:
        | HttpClientRequest.HttpClientRequest
        | HttpServerRequest.HttpServerRequest,
    ): any =>
      HttpClientRequest.isHttpClientRequest(request)
        ? pipe(
            HttpServerRequest.toWeb(
              HttpServerRequest.fromClientRequest(request),
            ),
            Effect.flatMap(fetch),
            Effect.map((response) =>
              HttpClientResponse.fromWeb(request, response as any as Response),
            ),
            Effect.catch((error) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(error.message, {
                    status:
                      error._tag === "InternalError"
                        ? 500
                        : error._tag === "RequestParseError"
                          ? 400
                          : 404,
                  }),
                ),
              ),
            ),
          )
        : pipe(
            HttpServerRequest.toWeb(request),
            Effect.flatMap(fetch),
            Effect.map((response) =>
              HttpServerResponse.fromWeb(response as any as Response),
            ),
          ),
  };
};
