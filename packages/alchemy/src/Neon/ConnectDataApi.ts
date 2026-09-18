import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import {
  backendEnvKey,
  backendString,
  bindBackendEnvironment,
} from "./BackendConnection.ts";
import type { DataApi } from "./DataApi.ts";

export class DataApiRequestError extends Data.TaggedError(
  "DataApiRequestError",
)<{ message: string }> {}

export interface ConnectDataApiClient {
  /** Bound public PostgREST endpoint. */
  baseUrl: Effect.Effect<string, never, RuntimeContext>;
  /** Execute a relative PostgREST request with this caller's token, never an admin key. */
  execute: (
    request: HttpClientRequest.HttpClientRequest,
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError | DataApiRequestError,
    RuntimeContext | Scope.Scope
  >;
}

/**
 * Bind a Data API endpoint and forward an explicitly supplied end-user token.
 * Relative URLs cannot redirect the authorization header to another origin.
 * Requests do not follow redirects, and response bodies remain request-scoped.
 *
 * ### Forward end-user authorization
 * **Example:** Query rows under the caller's RLS identity
 * ```typescript
 * const data = yield* Neon.ConnectDataApi(dataApi);
 * // In the request handler, after obtaining the caller's token:
 * const response = yield* data.execute(HttpClientRequest.get("todos?select=*"), token);
 * ```
 *
 * @binding
 */
export interface ConnectDataApi extends Binding.Service<
  ConnectDataApi,
  "Neon.ConnectDataApi",
  (dataApi: DataApi) => Effect.Effect<ConnectDataApiClient>
> {}
export const ConnectDataApi = Binding.Service<ConnectDataApi>(
  "Neon.ConnectDataApi",
);

/** Data API transport, with the host and HTTP client encapsulated at initialization. */
export const ConnectDataApiBinding = Layer.effect(
  ConnectDataApi,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return Effect.fn(function* (dataApi: DataApi) {
      const key = backendEnvKey(dataApi.FQN, "DATA_API_URL");
      yield* bindBackendEnvironment(`Neon.ConnectDataApi:${dataApi.FQN}`, {
        [key]: dataApi.url,
      });
      const baseUrl = backendString(key);
      return {
        baseUrl,
        execute: Effect.fn(function* (
          request: HttpClientRequest.HttpClientRequest,
          token: Redacted.Redacted<string>,
        ) {
          if (!Redacted.value(token))
            return yield* new DataApiRequestError({
              message: "An end-user token is required",
            });
          const base = (yield* baseUrl).replace(/\/$/, "") + "/";
          const target = yield* Effect.try({
            try: () => new URL(request.url.replace(/^\/(?!\/)/, ""), base),
            catch: () =>
              new DataApiRequestError({
                message: "Invalid relative Data API URL",
              }),
          });
          const origin = yield* Effect.sync(() => new URL(base));
          if (
            target.origin !== origin.origin ||
            !target.pathname.startsWith(origin.pathname) ||
            target.username ||
            target.password
          ) {
            return yield* new DataApiRequestError({
              message: "Data API request must stay within its bound endpoint",
            });
          }
          return yield* http
            .execute(
              request.pipe(
                HttpClientRequest.setUrl(target.href),
                HttpClientRequest.bearerToken(token),
              ),
            )
            .pipe(
              Effect.provideService(FetchHttpClient.RequestInit, {
                redirect: "manual",
              }),
            );
        }),
      } satisfies ConnectDataApiClient;
    });
  }),
);

/** HTTP-host variant; the caller's token is forwarded unchanged on every host. */
export const ConnectDataApiHttp = ConnectDataApiBinding;
