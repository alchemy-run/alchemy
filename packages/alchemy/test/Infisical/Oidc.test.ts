import { expect, it } from "alchemy-test";
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
import { detectOidcToken } from "@/Infisical/Oidc.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

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

/** Run the detector against a fake environment and a fake HTTP world. */
const detect = (
  env: Record<string, string>,
  handler: Handler = () => Effect.die("No network expected"),
) =>
  detectOidcToken.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ env }),
    ),
    Effect.provideService(HttpClient.HttpClient, fakeClient(handler)),
  );

it.effect("returns nothing on a plain laptop", () =>
  detect({}).pipe(Effect.map((found) => expect(found).toBeUndefined())),
);

it.effect("an explicit INFISICAL_OIDC_TOKEN wins over every platform", () =>
  detect({
    INFISICAL_OIDC_TOKEN: "explicit-jwt",
    VERCEL: "1",
    VERCEL_OIDC_TOKEN: "vercel-jwt",
  }).pipe(
    Effect.map((found) => {
      expect(found?.platform).toBe("explicit");
      expect(Redacted.value(found!.token)).toBe("explicit-jwt");
    }),
  ),
);

it.effect("Vercel exposes the token in the environment", () =>
  detect({ VERCEL: "1", VERCEL_OIDC_TOKEN: "vercel-jwt" }).pipe(
    Effect.map((found) => {
      expect(found?.platform).toBe("vercel");
      expect(Redacted.value(found!.token)).toBe("vercel-jwt");
    }),
  ),
);

it.effect("GitHub Actions requests the token with the audience", () =>
  detect(
    {
      GITHUB_ACTIONS: "true",
      ACTIONS_ID_TOKEN_REQUEST_URL:
        "https://pipelines.actions.githubusercontent.com/token?scope=x",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      INFISICAL_OIDC_AUDIENCE: "infisical",
    },
    (request) =>
      Effect.sync(() => {
        // Effect keeps the query separate from the URL on outgoing requests.
        const url = new URL(request.url);
        const query = Object.fromEntries(request.urlParams);
        expect(url.host).toBe("pipelines.actions.githubusercontent.com");
        expect(query).toEqual({ scope: "x", audience: "infisical" });
        expect(request.headers.authorization).toBe("Bearer request-token");
        return Response.json({ value: "github-jwt" });
      }),
  ).pipe(
    Effect.map((found) => {
      expect(found?.platform).toBe("github-actions");
      expect(Redacted.value(found!.token)).toBe("github-jwt");
    }),
  ),
);

it.effect(
  "a GitHub Actions job without id-token permission yields nothing",
  () =>
    detect({ GITHUB_ACTIONS: "true" }).pipe(
      Effect.map((found) => expect(found).toBeUndefined()),
    ),
);

it.effect(
  "GitLab prefers CI_JOB_JWT_V2 and falls back to SIGSTORE_ID_TOKEN",
  () =>
    Effect.all([
      detect({
        GITLAB_CI: "true",
        CI_JOB_JWT_V2: "v2",
        SIGSTORE_ID_TOKEN: "sig",
      }),
      detect({ GITLAB_CI: "true", SIGSTORE_ID_TOKEN: "sig" }),
    ]).pipe(
      Effect.map(([preferred, fallback]) => {
        expect(preferred?.platform).toBe("gitlab");
        expect(Redacted.value(preferred!.token)).toBe("v2");
        expect(Redacted.value(fallback!.token)).toBe("sig");
      }),
    ),
);

it.effect("Fly mints the token from the internal API", () =>
  detect(
    { FLY_APP_NAME: "my-app", INFISICAL_OIDC_AUDIENCE: "infisical" },
    (request) =>
      Effect.gen(function* () {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("http://_api.internal:4280/v1/tokens/oidc");
        expect(yield* readJsonBody(request)).toEqual({ aud: "infisical" });
        return new Response("fly-jwt\n");
      }),
  ).pipe(
    Effect.map((found) => {
      expect(found?.platform).toBe("fly");
      expect(Redacted.value(found!.token)).toBe("fly-jwt");
    }),
  ),
);

it.effect(
  "GCP reads the metadata server only when a GCP runtime is detected",
  () =>
    Effect.all([
      detect({ K_SERVICE: "svc" }, (request) =>
        Effect.sync(() => {
          const url = new URL(request.url);
          expect(url.host).toBe("metadata.google.internal");
          expect(request.headers["metadata-flavor"]).toBe("Google");
          return new Response("gcp-jwt");
        }),
      ),
      detect({}),
    ]).pipe(
      Effect.map(([onGcp, elsewhere]) => {
        expect(onGcp?.platform).toBe("gcp");
        expect(Redacted.value(onGcp!.token)).toBe("gcp-jwt");
        expect(elsewhere).toBeUndefined();
      }),
    ),
);

it.effect("a failing probe is treated as not detected, not as an error", () =>
  detect({ FLY_APP_NAME: "my-app" }, () =>
    Effect.fail(new Error("connection refused")),
  ).pipe(Effect.map((found) => expect(found).toBeUndefined())),
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
