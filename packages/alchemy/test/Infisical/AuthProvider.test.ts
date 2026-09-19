import { expect, it } from "alchemy-test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { AuthProviders, getAuthProvider } from "@/Auth/AuthProvider.ts";
import {
  InfisicalAuth,
  type InfisicalAuthConfig,
  type InfisicalResolvedCredentials,
} from "@/Infisical/AuthProvider.ts";
import { Interaction } from "@/Interaction.ts";

/** Decode the JSON body the SDK encoded onto an outgoing request. */
const readJsonBody = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.sync(() => {
    const body = request.body;
    if (body._tag !== "Uint8Array") {
      throw new Error(`Expected a JSON body, got ${body._tag}`);
    }
    return JSON.parse(new TextDecoder().decode(body.body)) as unknown;
  });

const interaction: Interaction["Service"] = {
  output: {
    info: () => Effect.void,
    success: () => Effect.void,
    warning: () => Effect.void,
    error: () => Effect.void,
  },
  prompt: {
    text: () => Effect.die("Unexpected text prompt"),
    password: () => Effect.die("Unexpected password prompt"),
    select: () => Effect.die("Unexpected select prompt"),
    confirm: () => Effect.die("Unexpected confirm prompt"),
    multiSelect: () => Effect.die("Unexpected multiSelect prompt"),
    awaitExternal: () => Effect.die("Unexpected awaitExternal prompt"),
  },
  task: (_, effect) => effect,
};

/**
 * A fake Infisical API that only knows the universal-auth login endpoint.
 * It issues `minted-token` for the `good-id` / `good-secret` pair and 401s
 * anything else.
 */
const fakeLogin = (
  check?: (request: HttpClientRequest.HttpClientRequest) => void,
) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      check?.(request);
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/v1/auth/universal-auth/login");
      expect(request.headers.authorization).toBeUndefined();
      const body = (yield* readJsonBody(request)) as {
        clientId: string;
        clientSecret: string;
      };
      const accepted =
        body.clientId === "good-id" && body.clientSecret === "good-secret";
      return HttpClientResponse.fromWeb(
        request,
        accepted
          ? Response.json({
              accessToken: "minted-token",
              expiresIn: 3600,
              accessTokenMaxTTL: 86400,
              tokenType: "Bearer",
            })
          : Response.json({ message: "Invalid credentials" }, { status: 401 }),
      );
    }),
  );

const withProvider = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  client: HttpClient.HttpClient = fakeLogin(),
) =>
  effect.pipe(
    Effect.provide(InfisicalAuth),
    Effect.provideService(AuthProviders, {}),
    Effect.provideService(Interaction, interaction),
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provide(NodeServices.layer),
  );

const auth = getAuthProvider<InfisicalAuthConfig, InfisicalResolvedCredentials>(
  "Infisical",
);

it.effect(
  "universal-auth configuration verifies the credentials by logging in",
  () =>
    withProvider(
      Effect.gen(function* () {
        const provider = yield* auth;
        const config = yield* provider.configureWith!("infisical-test", {
          method: "universal-auth",
          values: { clientId: "good-id", clientSecret: "good-secret" },
        });
        expect(config).toEqual({
          method: "universal-auth",
          clientId: "good-id",
          clientSecret: "good-secret",
          apiBaseUrl: undefined,
        });

        const rejected = yield* provider.configureWith!("infisical-test", {
          method: "universal-auth",
          values: { clientId: "good-id", clientSecret: "typo" },
        }).pipe(Effect.result);
        expect(Result.isFailure(rejected)).toBe(true);
        if (Result.isFailure(rejected)) {
          expect(rejected.failure.message).toContain(
            "rejected the machine identity",
          );
        }
      }),
    ),
);

it.effect("reading a universal-auth profile mints a fresh access token", () =>
  withProvider(
    Effect.gen(function* () {
      const provider = yield* auth;
      const credentials = yield* provider.read("infisical-test", {
        method: "universal-auth",
        clientId: "good-id",
        clientSecret: "good-secret",
        apiBaseUrl: "https://infisical.example.com",
      });
      expect(Redacted.value(credentials.token)).toBe("minted-token");
      expect(credentials.apiBaseUrl).toBe("https://infisical.example.com");
    }),
    fakeLogin((request) => {
      expect(new URL(request.url).origin).toBe("https://infisical.example.com");
    }),
  ),
);

it.effect("access-token configuration and read make no network requests", () =>
  withProvider(
    Effect.gen(function* () {
      const provider = yield* auth;
      const config = yield* provider.configureWith!("infisical-test", {
        method: "access-token",
        values: { token: "pasted-token" },
      });
      expect(config).toEqual({
        method: "access-token",
        token: "pasted-token",
        apiBaseUrl: undefined,
      });
      const credentials = yield* provider.read("infisical-test", config);
      expect(Redacted.value(credentials.token)).toBe("pasted-token");
      expect(credentials.apiBaseUrl).toBe("https://us.infisical.com");
      yield* provider.logout("infisical-test", config);
    }),
    HttpClient.make(() => Effect.die("No network expected")),
  ),
);

it.effect("rejects unknown methods and missing fields", () =>
  withProvider(
    Effect.gen(function* () {
      const provider = yield* auth;
      const unknown = yield* provider.configureWith!("infisical-test", {
        method: "login",
        values: {},
      }).pipe(Effect.result);
      expect(Result.isFailure(unknown)).toBe(true);
      if (Result.isFailure(unknown)) {
        expect(unknown.failure.message).toContain("Valid methods");
      }
      const missing = yield* provider.configureWith!("infisical-test", {
        method: "universal-auth",
        values: { clientId: "good-id" },
      }).pipe(Effect.result);
      expect(Result.isFailure(missing)).toBe(true);
      if (Result.isFailure(missing)) {
        expect(missing.failure.message).toContain("clientSecret");
      }
    }),
    HttpClient.make(() => Effect.die("No network expected")),
  ),
);

it.effect(
  "environment credentials read INFISICAL_TOKEN and INFISICAL_API_URL",
  () =>
    withProvider(
      Effect.gen(function* () {
        const provider = yield* auth;
        const credentials = yield* provider.readEnvironment!.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({
              env: {
                INFISICAL_TOKEN: "ci-token",
                INFISICAL_API_URL: "https://infisical.example.com",
              },
            }),
          ),
        );
        expect(Redacted.value(credentials.token)).toBe("ci-token");
        expect(credentials.apiBaseUrl).toBe("https://infisical.example.com");

        const missing = yield* provider.readEnvironment!.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: {} }),
          ),
          Effect.result,
        );
        expect(Result.isFailure(missing)).toBe(true);
        if (Result.isFailure(missing)) {
          expect(missing.failure.message).toContain("set INFISICAL_TOKEN");
        }
      }),
      HttpClient.make(() => Effect.die("No network expected")),
    ),
);
