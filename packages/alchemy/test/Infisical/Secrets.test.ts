import { expect, it } from "alchemy-test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { AuthError, AuthProviders } from "@/Auth/AuthProvider.ts";
import { ProfileStore, SuppressMissingProviderConfig } from "@/Auth/Profile.ts";
import type { InfisicalAuthConfig } from "@/Infisical/AuthProvider.ts";
import { Infisical } from "@/Secrets/Infisical.ts";
import { Stage } from "@/Stage.ts";
import { Stack, inMemoryState } from "@/index.ts";

/** Decode the JSON body the SDK encoded onto an outgoing request. */
const readJsonBody = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.sync(() => {
    const body = request.body;
    if (body._tag !== "Uint8Array") {
      throw new Error(`Expected a JSON body, got ${body._tag}`);
    }
    return JSON.parse(new TextDecoder().decode(body.body)) as unknown;
  });

/**
 * A profile store whose single profile either has the given stored Infisical
 * configuration or no Infisical configuration at all.
 */
const profileStore = (stored?: InfisicalAuthConfig) =>
  ({
    current: Effect.succeed({ name: "infisical-test", source: "default" }),
    loadProviderConfig: () =>
      stored === undefined
        ? Effect.fail(
            new AuthError({
              message:
                "Infisical is not configured. Run `alchemy profile edit --profile infisical-test --add Infisical`.",
            }),
          )
        : Effect.succeed(stored),
  }) as unknown as ProfileStore["Service"];

const machineIdentity: InfisicalAuthConfig = {
  method: "universal-auth",
  clientId: "good-id",
  clientSecret: "good-secret",
};

const secretsListing = (
  secrets: Record<string, string>,
  imports: Record<string, string> = {},
) => ({
  secrets: Object.entries(secrets).map(([secretKey, secretValue]) => ({
    id: secretKey,
    _id: secretKey,
    workspace: "app",
    environment: "dev",
    version: 1,
    type: "shared",
    secretKey,
    secretValue,
    secretComment: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    secretValueHidden: false,
  })),
  imports: [
    {
      secretPath: "/shared",
      environment: "dev",
      secrets: Object.entries(imports).map(([secretKey, secretValue]) => ({
        id: secretKey,
        _id: secretKey,
        workspace: "app",
        environment: "dev",
        version: 1,
        type: "shared",
        secretKey,
        secretValue,
        secretComment: "",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        secretValueHidden: false,
      })),
    },
  ],
});

interface FakeInfisical {
  /** Process environment visible to the layer under test. */
  env?: Record<string, string>;
  /** Infisical configuration stored in the selected profile, if any. */
  stored?: InfisicalAuthConfig;
  /** HTTP status the fake secrets endpoint answers with. */
  status?: number;
  /**
   * Response body of the fake secrets endpoint: a listing on success, or
   * Infisical's `{ message }` error envelope alongside a non-2xx `status`.
   * May depend on the request (e.g. its query).
   */
  body?:
    | Record<string, unknown>
    | ((
        request: HttpClientRequest.HttpClientRequest,
      ) => Record<string, unknown>);
  /** Inspect (or reject) every secrets request that reaches the fake API. */
  check?: (request: HttpClientRequest.HttpClientRequest) => void;
}

/**
 * Run an effect against a fake Infisical API, profile store, and
 * environment. The fake API mints `minted-token` for the `good-id` /
 * `good-secret` machine identity and serves the secrets endpoint from
 * `body`.
 */
const withFakeInfisical = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: FakeInfisical = {},
) =>
  effect.pipe(
    Effect.provideService(ProfileStore, profileStore(options.stored)),
    Effect.provideService(AuthProviders, {}),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ env: options.env ?? {} }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          const url = new URL(request.url);
          if (url.pathname === "/api/v1/auth/universal-auth/login") {
            const body = (yield* readJsonBody(request)) as {
              clientId: string;
              clientSecret: string;
            };
            const accepted =
              body.clientId === "good-id" &&
              body.clientSecret === "good-secret";
            return HttpClientResponse.fromWeb(
              request,
              accepted
                ? Response.json({
                    accessToken: "minted-token",
                    expiresIn: 3600,
                    accessTokenMaxTTL: 86400,
                    tokenType: "Bearer",
                  })
                : Response.json(
                    { message: "Invalid credentials" },
                    { status: 401 },
                  ),
            );
          }
          options.check?.(request);
          expect(url.pathname).toBe("/api/v3/secrets/raw");
          const body =
            (typeof options.body === "function"
              ? options.body(request)
              : options.body) ??
            secretsListing({
              INFISICAL_TEST_VALUE: "remote",
              INFISICAL_TEST_EMPTY: "",
            });
          return HttpClientResponse.fromWeb(
            request,
            Response.json(body, { status: options.status ?? 200 }),
          );
        }),
      ),
    ),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  );

it.effect(
  "supports stage-dependent options without mutating process.env",
  () => {
    const before = process.env.INFISICAL_TEST_VALUE;
    return withFakeInfisical(
      Effect.gen(function* () {
        const result = yield* Effect.all([
          Config.String("INFISICAL_TEST_VALUE"),
          Config.String("INFISICAL_TEST_EMPTY"),
        ]).pipe(
          Effect.provide(
            Infisical(
              Effect.gen(function* () {
                return { project: "app", environment: yield* Stage };
              }),
            ),
          ),
        );
        expect(result).toEqual(["remote", ""]);
        expect(process.env.INFISICAL_TEST_VALUE).toBe(before);
      }).pipe(Effect.provideService(Stage, "dev")),
      {
        env: { INFISICAL_TOKEN: "environment" },
        check: (request) => {
          expect(request.headers.authorization).toBe("Bearer environment");
          const query = Object.fromEntries(new URL(request.url).searchParams);
          expect(query).toEqual({
            workspaceSlug: "app",
            environment: "dev",
            include_imports: "true",
            viewSecretValue: "true",
            expandSecretReferences: "true",
          });
        },
      },
    );
  },
);

it.effect(
  "INFISICAL_TOKEN and INFISICAL_API_URL work in CI without a profile",
  () =>
    withFakeInfisical(
      Config.String("INFISICAL_TEST_VALUE").pipe(
        Effect.provide(
          Infisical({
            project: "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c",
            environment: "prod",
          }),
        ),
        Effect.map((value) => expect(value).toBe("remote")),
      ),
      {
        env: {
          CI: "true",
          INFISICAL_TOKEN: "ci-token",
          INFISICAL_API_URL: "https://infisical.example.com",
        },
        check: (request) => {
          expect(request.headers.authorization).toBe("Bearer ci-token");
          const url = new URL(request.url);
          expect(url.origin).toBe("https://infisical.example.com");
          // A UUID is sent as the project id; a slug as the project slug.
          expect(url.searchParams.get("workspaceId")).toBe(
            "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c",
          );
          expect(url.searchParams.get("workspaceSlug")).toBeNull();
        },
      },
    ),
);

it.effect(
  "a stored machine identity mints a token and loads secrets without Interaction",
  () =>
    withFakeInfisical(
      Config.String("INFISICAL_TEST_VALUE").pipe(
        Effect.provide(Infisical({ project: "app", environment: "dev" })),
        Effect.asVoid,
      ),
      {
        stored: machineIdentity,
        check: (request) =>
          expect(request.headers.authorization).toBe("Bearer minted-token"),
      },
    ),
);

it.effect("directly defined secrets override imported ones", () =>
  withFakeInfisical(
    Effect.all([
      Config.String("INFISICAL_TEST_VALUE"),
      Config.String("INFISICAL_TEST_IMPORTED"),
    ]).pipe(
      Effect.provide(Infisical({ project: "app", environment: "dev" })),
      Effect.map((values) => expect(values).toEqual(["direct", "imported"])),
    ),
    {
      env: { INFISICAL_TOKEN: "environment" },
      body: secretsListing(
        { INFISICAL_TEST_VALUE: "direct" },
        {
          INFISICAL_TEST_VALUE: "shadowed",
          INFISICAL_TEST_IMPORTED: "imported",
        },
      ),
    },
  ),
);

it.effect(
  "missing credentials fail with a setup instruction and no network",
  () =>
    withFakeInfisical(
      Config.String("INFISICAL_TEST_VALUE").pipe(
        Effect.provide(Infisical({ project: "app", environment: "dev" })),
        Effect.result,
        Effect.map((result) => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(String(result.failure)).toContain("--add Infisical");
          }
        }),
      ),
      {
        check: () => {
          throw new Error("Must not request secrets");
        },
      },
    ),
);

it.effect("a rejected token instructs a profile refresh", () =>
  withFakeInfisical(
    Config.String("INFISICAL_TEST_VALUE").pipe(
      Effect.provide(Infisical({ project: "app", environment: "dev" })),
      Effect.result,
      Effect.map((result) => {
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(String(result.failure)).toContain(
            "alchemy profile refresh --profile infisical-test --provider Infisical",
          );
        }
      }),
    ),
    {
      stored: { method: "access-token", token: "revoked" },
      status: 401,
      body: { message: "Unauthorized" },
    },
  ),
);

it.effect(
  "names Infisical and the selection when the project is not found",
  () =>
    withFakeInfisical(
      Config.String("INFISICAL_TEST_VALUE").pipe(
        Effect.provide(
          Infisical({ project: "nope", environment: "dev", path: "/api" }),
        ),
        Effect.result,
        Effect.map((result) => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("InfisicalSecretsError");
            expect(String(result.failure)).toContain(
              "Infisical could not read project 'nope' environment 'dev' path '/api'",
            );
            expect(String(result.failure)).toContain("Project not found");
          }
        }),
      ),
      {
        env: { INFISICAL_TOKEN: "environment" },
        status: 404,
        body: { message: "Project not found" },
      },
    ),
);

it.effect(
  "later Infisical layers win and the process environment keeps priority",
  () => {
    const environments: string[] = [];
    return withFakeInfisical(
      Stack(
        "infisical-layers",
        {
          providers: Layer.empty,
          state: inMemoryState(),
          secrets: [
            // A stack's ConfigProvider is built from the real process
            // environment, so feed INFISICAL_TOKEN in through an earlier
            // secrets layer; later layers see values from earlier ones.
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { INFISICAL_TOKEN: "layered" } }),
            ),
            Infisical({ project: "app", environment: "first" }),
            Infisical({ project: "app", environment: "second" }),
          ],
        },
        Effect.all([
          Config.String("INFISICAL_TEST_VALUE"),
          Config.String("PATH"),
        ]),
      ).pipe(
        Effect.provideService(Stage, "test"),
        Effect.map(({ output: [value, path] }) => {
          expect(value).toBe("second");
          expect(path).toBe(process.env.PATH!);
          expect(environments).toEqual(["first", "second"]);
        }),
      ),
      {
        body: (request) =>
          secretsListing({
            INFISICAL_TEST_VALUE: new URL(request.url).searchParams.get(
              "environment",
            )!,
            PATH: "remote-path",
          }),
        check: (request) => {
          expect(request.headers.authorization).toBe("Bearer layered");
          environments.push(
            new URL(request.url).searchParams.get("environment")!,
          );
        },
      },
    );
  },
);

it.effect("auth provider discovery skips secrets and stage options", () =>
  withFakeInfisical(
    Layer.build(
      Infisical(
        Effect.die("Do not evaluate deployment options during auth discovery"),
      ),
    ).pipe(
      Effect.provideService(SuppressMissingProviderConfig, true),
      Effect.asVoid,
    ),
    {
      stored: machineIdentity,
      check: () => {
        throw new Error("No API calls during auth discovery");
      },
    },
  ),
);
