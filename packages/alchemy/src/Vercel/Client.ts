import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Credentials } from "./Credentials.ts";
import { VercelError, VercelNotFound } from "./Errors.ts";

export const VERCEL_API_BASE_URL = "https://api.vercel.com";

/** Team scope attached to every request when the domain is team-owned. */
export interface VercelTeamScope {
  readonly teamId?: string;
  readonly teamSlug?: string;
}

const withTeamScope = (url: URL, scope: VercelTeamScope | undefined): URL => {
  const teamId = scope?.teamId;
  const teamSlug = scope?.teamSlug;
  if (teamId !== undefined) {
    url.searchParams.set("teamId", teamId);
  } else if (teamSlug !== undefined) {
    url.searchParams.set("slug", teamSlug);
  }
  return url;
};

const toVercelError = (
  status: number,
  body: unknown,
): VercelError | VercelNotFound => {
  const record = (typeof body === "object" && body !== null ? body : {}) as {
    error?: { code?: string; message?: string };
  };
  const message =
    record.error?.message ?? `Vercel API request failed with status ${status}`;
  if (status === 404) {
    return new VercelNotFound({ message });
  }
  return new VercelError({
    status,
    code: record.error?.code,
    message,
  });
};

/**
 * Thin Effect wrapper over the Vercel REST API.
 *
 * Auth and team scope come from ambient `Credentials`. All methods return
 * decoded JSON; HTTP errors surface as {@link VercelError} (404 as
 * {@link VercelNotFound}).
 */
export interface VercelClient {
  readonly get: (
    path: string,
    scope?: VercelTeamScope,
  ) => Effect.Effect<unknown, VercelError | VercelNotFound>;
  readonly post: (
    path: string,
    body: unknown,
    scope?: VercelTeamScope,
  ) => Effect.Effect<unknown, VercelError | VercelNotFound>;
  readonly patch: (
    path: string,
    body: unknown,
    scope?: VercelTeamScope,
  ) => Effect.Effect<unknown, VercelError | VercelNotFound>;
  readonly del: (
    path: string,
    scope?: VercelTeamScope,
  ) => Effect.Effect<unknown, VercelError | VercelNotFound>;
}

export class Client extends Context.Service<Client, VercelClient>()(
  "Vercel.Client",
) {}

export const ClientLive: Layer.Layer<
  Client,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  Client,
  Effect.gen(function* () {
    const creds = yield* Credentials;
    const http = yield* HttpClient.HttpClient;

    const request = (
      method: "GET" | "POST" | "PATCH" | "DELETE",
      path: string,
      body: unknown,
      scope: VercelTeamScope | undefined,
    ) =>
      Effect.gen(function* () {
        const url = withTeamScope(new URL(`${VERCEL_API_BASE_URL}${path}`), {
          teamId: scope?.teamId ?? creds.teamId,
          teamSlug: scope?.teamSlug ?? creds.teamSlug,
        }).toString();
        const base =
          method === "POST"
            ? HttpClientRequest.post(url)
            : method === "PATCH"
              ? HttpClientRequest.patch(url)
              : method === "DELETE"
                ? HttpClientRequest.delete(url)
                : HttpClientRequest.get(url);
        const withAuth = base.pipe(HttpClientRequest.bearerToken(creds.token));
        const req =
          body !== undefined
            ? yield* HttpClientRequest.bodyJson(body)(withAuth).pipe(
                Effect.mapError(
                  () =>
                    new VercelError({
                      status: 0,
                      message: "Request is not JSON serializable",
                    }),
                ),
              )
            : withAuth;
        const response = yield* http.execute(req).pipe(
          Effect.catch(() =>
            Effect.fail(
              new VercelError({
                status: 0,
                message: "Vercel API transport failure",
              }),
            ),
          ),
        );
        const status = response.status;
        if (status === 204) {
          return undefined;
        }
        const parsed: unknown = yield* response.json.pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
        if (status >= 200 && status < 300) {
          return parsed;
        }
        return yield* Effect.fail(toVercelError(status, parsed));
      });

    return {
      get: (path, scope) => request("GET", path, undefined, scope),
      post: (path, body, scope) => request("POST", path, body, scope),
      patch: (path, body, scope) => request("PATCH", path, body, scope),
      del: (path, scope) => request("DELETE", path, undefined, scope),
    } satisfies VercelClient;
  }),
);

/** Ambient HTTP client used by the Vercel resources. */
export const HttpLive = FetchHttpClient.layer;
