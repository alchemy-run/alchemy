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
  DopplerAuth,
  type DopplerAuthConfig,
  type DopplerResolvedCredentials,
} from "@/Doppler/AuthProvider.ts";

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

const auth = getAuthProvider<DopplerAuthConfig, DopplerResolvedCredentials>(
  "Doppler",
);

/** The provider's environment path against a fake platform and fake Doppler. */
const readEnvironmentWith = (env: Record<string, string>, handler: Handler) =>
  Effect.gen(function* () {
    const provider = yield* auth;
    return yield* provider.readEnvironment!;
  }).pipe(
    Effect.provide(DopplerAuth),
    Effect.provideService(AuthProviders, {}),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ env }),
    ),
    Effect.provideService(HttpClient.HttpClient, fakeClient(handler)),
    Effect.provide(NodeServices.layer),
  );

it.effect(
  "DOPPLER_IDENTITY_ID exchanges the platform token for a short-lived token",
  () =>
    readEnvironmentWith(
      {
        DOPPLER_IDENTITY_ID: "identity-1",
        GITHUB_ACTIONS: "true",
        ACTIONS_ID_TOKEN_REQUEST_URL:
          "https://pipelines.actions.githubusercontent.com/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      },
      (request) =>
        Effect.gen(function* () {
          const url = new URL(request.url);
          if (url.host === "pipelines.actions.githubusercontent.com") {
            return Response.json({ value: "github-jwt" });
          }
          expect(url.pathname).toBe("/v3/auth/oidc");
          expect(request.headers.authorization).toBeUndefined();
          expect(yield* readJsonBody(request)).toEqual({
            identity: "identity-1",
            token: "github-jwt",
          });
          return Response.json({
            token: "dp.st.short",
            expires_at: "2026-09-20T00:00:00Z",
          });
        }),
    ).pipe(
      Effect.map((credentials) =>
        expect(Redacted.value(credentials.token)).toBe("dp.st.short"),
      ),
    ),
);

it.effect("DOPPLER_TOKEN takes precedence over OIDC", () =>
  readEnvironmentWith(
    {
      DOPPLER_TOKEN: "static",
      DOPPLER_IDENTITY_ID: "identity-1",
      DOPPLER_OIDC_TOKEN: "jwt",
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
    readEnvironmentWith({ DOPPLER_IDENTITY_ID: "identity-1" }, () =>
      Effect.die("No network expected"),
    ).pipe(
      Effect.result,
      Effect.map((result) => {
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain(
            "no platform OIDC token was found",
          );
          expect(result.failure.message).toContain("DOPPLER_OIDC_TOKEN");
        }
      }),
    ),
);

it.effect(
  "a rejected OIDC login names the identity and the plan requirement",
  () =>
    readEnvironmentWith(
      { DOPPLER_IDENTITY_ID: "identity-1", DOPPLER_OIDC_TOKEN: "jwt" },
      () =>
        Effect.succeed(Response.json({ messages: ["nope"] }, { status: 401 })),
    ).pipe(
      Effect.result,
      Effect.map((result) => {
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain(
            "OIDC login for identity 'identity-1'",
          );
          expect(result.failure.message).toContain("plan");
        }
      }),
    ),
);
