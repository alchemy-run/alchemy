import { expect, it } from "alchemy-test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { AuthProviders, getAuthProvider } from "@/Auth/AuthProvider.ts";
import {
  InfisicalAuth,
  type InfisicalAuthConfig,
  type InfisicalResolvedCredentials,
} from "@/Infisical/AuthProvider.ts";

/** Decode the JSON body encoded onto an outgoing request. */
const readJsonBody = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.sync(() => {
    const body = request.body;
    if (body._tag !== "Uint8Array") {
      throw new Error(`Expected a JSON body, got ${body._tag}`);
    }
    return JSON.parse(new TextDecoder().decode(body.body)) as unknown;
  });

type Handler = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<Response, unknown>;

/** An HttpClient backed by `handler`; a handler failure becomes a transport error. */
const fakeClient = (handler: Handler) =>
  HttpClient.make((request) =>
    handler(request).pipe(
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
      Effect.mapError(
        (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause }),
          }),
      ),
    ),
  );

const auth = getAuthProvider<InfisicalAuthConfig, InfisicalResolvedCredentials>(
  "Infisical",
);

/** The provider's environment path against a fake platform and fake Infisical. */
const readEnvironmentWith = (env: Record<string, string>, handler: Handler) =>
  Effect.gen(function* () {
    const provider = yield* auth;
    return yield* provider.readEnvironment!;
  }).pipe(
    Effect.provide(InfisicalAuth),
    Effect.provideService(AuthProviders, {}),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ env }),
    ),
    Effect.provideService(HttpClient.HttpClient, fakeClient(handler)),
    Effect.provide(NodeServices.layer),
  );

it.effect(
  "INFISICAL_IDENTITY_ID exchanges the platform token for an access token",
  () =>
    readEnvironmentWith(
      {
        INFISICAL_IDENTITY_ID: "identity-1",
        INFISICAL_API_URL: "https://infisical.example.com",
        VERCEL: "1",
        VERCEL_OIDC_TOKEN: "vercel-jwt",
      },
      (request) =>
        Effect.gen(function* () {
          const url = new URL(request.url);
          expect(url.origin).toBe("https://infisical.example.com");
          expect(url.pathname).toBe("/api/v1/auth/oidc-auth/login");
          expect(request.headers.authorization).toBeUndefined();
          expect(yield* readJsonBody(request)).toEqual({
            identityId: "identity-1",
            jwt: "vercel-jwt",
          });
          return Response.json({
            accessToken: "oidc-access-token",
            expiresIn: 3600,
            accessTokenMaxTTL: 86400,
            tokenType: "Bearer",
          });
        }),
    ).pipe(
      Effect.map((credentials) => {
        expect(Redacted.value(credentials.token)).toBe("oidc-access-token");
        expect(credentials.apiBaseUrl).toBe("https://infisical.example.com");
      }),
    ),
);

it.effect("INFISICAL_TOKEN takes precedence over OIDC", () =>
  readEnvironmentWith(
    {
      INFISICAL_TOKEN: "static",
      INFISICAL_IDENTITY_ID: "identity-1",
      VERCEL: "1",
      VERCEL_OIDC_TOKEN: "vercel-jwt",
    },
    () => Effect.die("No network expected"),
  ).pipe(
    Effect.map((credentials) =>
      expect(Redacted.value(credentials.token)).toBe("static"),
    ),
  ),
);

it.effect(
  "an identity id with no platform token explains what is supported",
  () =>
    readEnvironmentWith({ INFISICAL_IDENTITY_ID: "identity-1" }, () =>
      Effect.die("No network expected"),
    ).pipe(
      Effect.result,
      Effect.map((result) => {
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain(
            "no platform OIDC token was found",
          );
          expect(result.failure.message).toContain("INFISICAL_OIDC_TOKEN");
        }
      }),
    ),
);

it.effect("a rejected OIDC login names the identity", () =>
  readEnvironmentWith(
    { INFISICAL_IDENTITY_ID: "identity-1", INFISICAL_OIDC_TOKEN: "jwt" },
    () => Effect.succeed(Response.json({ message: "nope" }, { status: 401 })),
  ).pipe(
    Effect.result,
    Effect.map((result) => {
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.message).toContain(
          "OIDC login for identity 'identity-1'",
        );
      }
    }),
  ),
);
