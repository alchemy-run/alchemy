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
import { Doppler } from "@/Secrets/Doppler.ts";
import { Stage } from "@/Stage.ts";
import { Stack, inMemoryState } from "@/index.ts";

/**
 * A profile store whose single profile either has a stored Doppler browser
 * login (`token` given) or no Doppler configuration at all.
 */
const profileStore = (token?: string) =>
  ({
    current: Effect.succeed({ name: "doppler-test", source: "default" }),
    loadProviderConfig: () =>
      token === undefined
        ? Effect.fail(
            new AuthError({
              message:
                "Doppler is not configured. Run `alchemy profile edit --profile doppler-test --add Doppler`.",
            }),
          )
        : Effect.succeed({ method: "login", token }),
  }) as unknown as ProfileStore["Service"];

interface FakeDoppler {
  /** Process environment visible to the layer under test. */
  env?: Record<string, string>;
  /** Doppler login token stored in the selected profile, if any. */
  token?: string;
  /** HTTP status the fake Doppler API answers with. */
  status?: number;
  /** Secrets the fake API returns; may depend on the request (e.g. its token). */
  secrets?:
    | Record<string, string>
    | ((
        request: HttpClientRequest.HttpClientRequest,
      ) => Record<string, string>);
  /** Inspect (or reject) every request that reaches the fake API. */
  check?: (request: HttpClientRequest.HttpClientRequest) => void;
}

/** Run an effect against a fake Doppler API, profile store, and environment. */
const withFakeDoppler = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: FakeDoppler = {},
) =>
  effect.pipe(
    Effect.provideService(ProfileStore, profileStore(options.token)),
    Effect.provideService(AuthProviders, {}),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ env: options.env ?? {} }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          options.check?.(request);
          expect(new URL(request.url).pathname).toBe(
            "/v3/configs/config/secrets/download",
          );
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              (typeof options.secrets === "function"
                ? options.secrets(request)
                : options.secrets) ?? {
                DOPPLER_TEST_VALUE: "remote",
                DOPPLER_TEST_EMPTY: "",
              },
              { status: options.status ?? 200 },
            ),
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
    const before = process.env.DOPPLER_TEST_VALUE;
    return withFakeDoppler(
      Effect.gen(function* () {
        const result = yield* Effect.all([
          Config.String("DOPPLER_TEST_VALUE"),
          Config.String("DOPPLER_TEST_EMPTY"),
        ]).pipe(
          Effect.provide(
            Doppler(
              Effect.gen(function* () {
                return { project: "app", config: yield* Stage };
              }),
            ),
          ),
        );
        expect(result).toEqual(["remote", ""]);
        expect(process.env.DOPPLER_TEST_VALUE).toBe(before);
      }).pipe(Effect.provideService(Stage, "dev")),
      {
        env: { DOPPLER_TOKEN: "environment" },
        check: (request) => {
          expect(request.headers.authorization).toBe("Bearer environment");
          expect(new URL(request.url).searchParams.get("config")).toBe("dev");
        },
      },
    );
  },
);

it.effect(
  "DOPPLER_TOKEN works in CI without a profile or project/config selectors",
  () =>
    withFakeDoppler(
      Config.String("DOPPLER_TEST_VALUE").pipe(
        Effect.provide(Doppler()),
        Effect.map((value) => expect(value).toBe("remote")),
      ),
      {
        env: { CI: "true", DOPPLER_TOKEN: "ci-service-token" },
        check: (request) => {
          expect(request.headers.authorization).toBe("Bearer ci-service-token");
          expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual(
            { format: "json" },
          );
        },
      },
    ),
);

it.effect("environment token wins over a stored login token", () =>
  withFakeDoppler(
    Config.String("DOPPLER_TEST_VALUE").pipe(
      Effect.provide(Doppler()),
      Effect.asVoid,
    ),
    {
      token: "stored",
      env: { DOPPLER_TOKEN: "env-token" },
      check: (request) =>
        expect(request.headers.authorization).toBe("Bearer env-token"),
    },
  ),
);

it.effect(
  "stored login token loads the requested project and config without Interaction",
  () =>
    withFakeDoppler(
      Config.String("DOPPLER_TEST_VALUE").pipe(
        Effect.provide(Doppler({ project: "app", config: "dev" })),
        Effect.asVoid,
      ),
      {
        token: "stored",
        check: (request) =>
          expect(request.headers.authorization).toBe("Bearer stored"),
      },
    ),
);

it.effect(
  "missing credentials fail with a login instruction and no network or Interaction",
  () =>
    withFakeDoppler(
      Config.String("DOPPLER_TEST_VALUE").pipe(
        Effect.provide(Doppler()),
        Effect.result,
        Effect.map((result) => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(String(result.failure)).toContain("--add Doppler");
        }),
      ),
      {
        check: () => {
          throw new Error("Must not request login or secrets");
        },
      },
    ),
);

it.effect("missing CI token fails clearly without using a local profile", () =>
  withFakeDoppler(
    Config.String("DOPPLER_TEST_VALUE").pipe(
      Effect.provide(Doppler()),
      Effect.result,
      Effect.map((result) => {
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(String(result.failure)).toContain("Set DOPPLER_TOKEN");
      }),
    ),
    {
      token: "stored",
      env: { CI: "true" },
      check: () => {
        throw new Error("Must not request login or secrets");
      },
    },
  ),
);

it.effect("names Doppler and the selection when the project is not found", () =>
  withFakeDoppler(
    Config.String("DOPPLER_TEST_VALUE").pipe(
      Effect.provide(Doppler({ project: "dev", config: "dev" })),
      Effect.result,
      Effect.map((result) => {
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("DopplerSecretsError");
          expect(String(result.failure)).toContain(
            "Doppler could not find project 'dev' config 'dev'",
          );
          expect(String(result.failure)).toContain(
            "Could not find requested project 'dev'",
          );
        }
      }),
    ),
    {
      token: "stored",
      status: 404,
      secrets: {
        messages: ["Could not find requested project 'dev'"],
      },
    },
  ),
);

it.effect("rejected stored credentials instruct refresh and never log in", () =>
  withFakeDoppler(
    Config.String("DOPPLER_TEST_VALUE").pipe(
      Effect.provide(Doppler({ project: "app", config: "dev" })),
      Effect.result,
      Effect.map((result) => {
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(String(result.failure)).toContain(
            "alchemy profile refresh --profile doppler-test --provider Doppler",
          );
      }),
    ),
    { token: "revoked", status: 401 },
  ),
);

it.effect(
  "stored browser login requires project and config before requesting secrets",
  () =>
    withFakeDoppler(
      Config.String("DOPPLER_TEST_VALUE").pipe(
        Effect.provide(Doppler()),
        Effect.result,
        Effect.map((result) => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(String(result.failure)).toContain(
              "requires both project and config",
            );
        }),
      ),
      {
        token: "stored",
        check: () => {
          throw new Error("Missing project and config");
        },
      },
    ),
);

it.effect(
  "later Doppler layers win and the process environment keeps priority",
  () => {
    const projects: string[] = [];
    return withFakeDoppler(
      Stack(
        "doppler-layers",
        {
          providers: Layer.empty,
          state: inMemoryState(),
          secrets: [
            // A stack's ConfigProvider is built from the real process
            // environment, so feed DOPPLER_TOKEN in through an earlier
            // secrets layer; later layers see values from earlier ones.
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { DOPPLER_TOKEN: "layered" } }),
            ),
            Doppler({ project: "first", config: "dev" }),
            Doppler({ project: "second", config: "dev" }),
          ],
        },
        Effect.all([
          Config.String("DOPPLER_TEST_VALUE"),
          Config.String("PATH"),
        ]),
      ).pipe(
        Effect.provideService(Stage, "test"),
        Effect.map(({ output: [value, path] }) => {
          expect(value).toBe("second");
          expect(path).toBe(process.env.PATH!);
          expect(projects).toEqual(["first", "second"]);
        }),
      ),
      {
        secrets: (request) => ({
          DOPPLER_TEST_VALUE: new URL(request.url).searchParams.get("project")!,
          PATH: "remote-path",
        }),
        check: (request) => {
          expect(request.headers.authorization).toBe("Bearer layered");
          projects.push(new URL(request.url).searchParams.get("project")!);
        },
      },
    );
  },
);

it.effect(
  "auth provider discovery skips secrets and stage options even with expired credentials",
  () =>
    withFakeDoppler(
      Layer.build(
        Doppler(
          Effect.die(
            "Do not evaluate deployment options during auth discovery",
          ),
        ),
      ).pipe(
        Effect.provideService(SuppressMissingProviderConfig, true),
        Effect.asVoid,
      ),
      {
        token: "expired",
        status: 401,
        check: () => {
          throw new Error("No API calls during auth discovery");
        },
      },
    ),
);
