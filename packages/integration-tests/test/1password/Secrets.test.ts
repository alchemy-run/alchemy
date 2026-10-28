import * as SDK from "@1password/sdk";
import * as OnePassword from "@alchemy.run/1password";
import { resolveCredentials } from "@alchemy.run/1password/AuthProvider";
import { OnePasswordSdk } from "@alchemy.run/1password/internal/sdk";
import { describe, expect, it } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContext, inMemoryState, Secrets, Stack, Stage, type StackSecrets } from "alchemy";
import { AuthProviders, getAuthProvider } from "alchemy/Auth/AuthProvider";
import {
  ProfileStore,
  ProfileStoreLive,
  SuppressMissingProviderConfig,
} from "alchemy/Auth/Profile";
import * as Interaction from "alchemy/Interaction";
import type { SecretsOption, SecretsServices } from "alchemy/Secrets/Provider";
import { StackContext } from "alchemy/StackContext";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

const withEnv = <A, E, R>(
  values: Record<string, string | undefined>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(
        Object.keys(values).map((key) => [key, process.env[key]]),
      );
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
  ).pipe(Effect.andThen(effect), Effect.scoped);

const check = <A, E>(
  name: string,
  body: () => Effect.Effect<
    A,
    E,
    SecretsServices | Scope.Scope | TestClock.TestClock | Interaction.Interaction
  >,
) =>
  it.effect(
    name,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-1password-test-" });
        return yield* withEnv(
          {
            OP_SERVICE_ACCOUNT_TOKEN: "test-service-token",
            CI: "false",
            ALCHEMY_HOME: home,
            ALCHEMY_PROFILE: "1password-test",
          },
          Effect.suspend(body).pipe(
            Effect.provide(ProfileStoreLive),
            Effect.provideService(AuthProviders, {}),
            Effect.provideService(Stage, "test"),
            Effect.provideService(StackContext, {
              name: "1password-test",
              stage: "test",
              resources: {},
              bindings: {},
              actions: {},
            }),
            Effect.provideService(AlchemyContext, {
              dotAlchemy: ".alchemy",
              dev: false,
              adopt: false,
            }),
            Effect.provide(FetchHttpClient.layer),
            Effect.provide(Interaction.layerNonInteractive()),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    { exclusive: true, retry: 0 },
  );

const fixture = (
  options: {
    variables?: SDK.EnvironmentVariable[];
    createError?: Error;
    readError?: Error;
    loadError?: Error;
    validateError?: Error;
    referenceResponses?: SDK.ResolveAllResponse["individualResponses"];
    resolveError?: Error;
    hang?: "initialize" | "authenticate" | "read" | "resolve";
  } = {},
) => {
  const calls: {
    configs: Parameters<typeof SDK.createClient>[0][];
    environments: string[];
    references: string[][];
    loads: number;
  } = { configs: [], environments: [], references: [], loads: 0 };
  const boundary: typeof OnePasswordSdk.Service = {
    load: async () => {
      calls.loads++;
      if (options.loadError) throw options.loadError;
      if (options.hang === "initialize") return new Promise(() => {});
      return {
        ...SDK,
        Secrets: class extends SDK.Secrets {
          static override validateSecretReference(reference: string) {
            if (options.validateError) throw options.validateError;
            SDK.Secrets.validateSecretReference(reference);
          }
        },
        createClient: async (config) => {
          calls.configs.push(config);
          if (options.createError) throw options.createError;
          if (options.hang === "authenticate") return new Promise(() => {});
          return {
            secrets: {
              resolveAll: async (references) => {
                calls.references.push(references);
                if (options.resolveError) throw options.resolveError;
                if (options.hang === "resolve") return new Promise(() => {});
                return {
                  individualResponses:
                    options.referenceResponses ??
                    Object.fromEntries(
                      references.map((reference) => [
                        reference,
                        {
                          content: { secret: "resolved-secret", itemId: "item", vaultId: "vault" },
                        },
                      ]),
                    ),
                };
              },
            },
            environments: {
              getVariables: async (id) => {
                calls.environments.push(id);
                if (options.readError) throw options.readError;
                if (options.hang === "read") return new Promise(() => {});
                return {
                  variables: options.variables ?? [
                    { name: "ONEPASSWORD_TEST_SECRET", value: "secret-value", masked: true },
                    { name: "ONEPASSWORD_TEST_EMPTY", value: "", masked: false },
                    { name: "ONEPASSWORD_TEST_PUBLIC", value: id, masked: false },
                  ],
                };
              },
            },
          };
        },
      };
    },
  };
  const run = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options: SecretsOption<OnePassword.OnePasswordOptions> = { environmentId: "development-id" },
  ) =>
    effect.pipe(
      Effect.provide(OnePassword.Secrets(options).layer),
      Effect.provideService(OnePasswordSdk, boundary),
    );
  return { calls, boundary, run };
};

const read = Config.String("ONEPASSWORD_TEST_SECRET");

const runStack = <A>(
  secrets: StackSecrets,
  body: Effect.Effect<A, Config.ConfigError>,
  stage = "test",
) =>
  Stack("1password-tests", { providers: Layer.empty, state: inMemoryState(), secrets }, body).pipe(
    Effect.map((stack) => stack.output),
    Effect.provideService(Stage, stage),
    Effect.provideService(AlchemyContext, { dotAlchemy: ".alchemy", dev: false, adopt: false }),
  );

describe("1Password secrets", { tags: ["unit", "local"] }, () => {
  check("validates reference syntax offline with a reusable schema", () =>
    Effect.sync(() => {
      const valid = [
        "op://vault/item/field",
        "op://My Vault/My Item/My Section/My Field",
        "op://vault/item/a.b_c-d",
        "op://vault/item/field?attribute=otp",
        "op://vault/item/field?ssh-format=openssh",
      ];
      const invalid = [
        "",
        "secret-value",
        "https://vault/item/field",
        "OP://vault/item/field",
        "op://vault/item",
        "op:///item/field",
        "op://vault//field",
        "op://vault/item/",
        "op://vault/item//field",
        "op://vault/item/section/field/extra",
        "op:// /item/field",
        "op://vault/item/ ",
        "op://vault/item/field#fragment",
        "op://vault/item/hello%20world",
        "op://vault/item/field\n",
        "op://vault/item/fi\teld",
        "op://vault/item/中文",
        "op://vault/item/field?bogus=1",
        "op://vault/item/field?attribute=value",
        "op://vault/item/field?attribute=otp&ssh-format=openssh",
        "op://vault/item/field?attribute=otp&attribute=otp",
        "op://vault/item/field?",
      ];
      for (const reference of valid) {
        expect(Schema.decodeUnknownSync(OnePassword.SecretReference)(reference)).toBe(reference);
        expect(() => SDK.Secrets.validateSecretReference(reference)).not.toThrow();
      }
      for (const reference of invalid) {
        expect(
          Result.isFailure(Schema.decodeUnknownResult(OnePassword.SecretReference)(reference)),
        ).toBe(true);
      }
    }),
  );

  check("resolves stage-dependent, deduplicated references once without mutating process.env", () =>
    Effect.gen(function* () {
      const test = fixture();
      const before = process.env.ONEPASSWORD_TEST_SECRET;
      const result = yield* test.run(
        Effect.all([read, read, Config.String("ALIAS")]),
        ({ stage }) => ({
          references: {
            ONEPASSWORD_TEST_SECRET: `op://${stage}/Database/url`,
            ALIAS: `op://${stage}/Database/url`,
          },
        }),
      );
      expect(result).toEqual(["resolved-secret", "resolved-secret", "resolved-secret"]);
      expect(test.calls.references).toEqual([["op://test/Database/url"]]);
      expect(test.calls.environments).toEqual([]);
      expect(test.calls.configs.length).toBe(1);
      expect(process.env.ONEPASSWORD_TEST_SECRET).toBe(before);
    }),
  );

  check(
    "loads references in a real stack with desktop authentication and preserves empty strings",
    () =>
      withEnv(
        { OP_SERVICE_ACCOUNT_TOKEN: undefined },
        Effect.gen(function* () {
          const test = fixture({
            referenceResponses: {
              "op://vault/item/field": {
                content: { secret: "", itemId: "item", vaultId: "vault" },
              },
            },
          });
          const result = yield* runStack(
            [
              OnePassword.Secrets({
                references: { ONEPASSWORD_TEST_SECRET: "op://vault/item/field" },
                account: "My Account",
              }),
            ],
            read,
          ).pipe(Effect.provideService(OnePasswordSdk, test.boundary));
          expect(result).toBe("");
          expect(test.calls.configs[0].auth).toBeInstanceOf(SDK.DesktopAuth);
        }),
      ),
  );

  check("rejects invalid references and ambiguous options before any SDK call", () =>
    Effect.gen(function* () {
      for (const options of [
        { references: { SECRET: "not-a-reference-private-value" } },
        { references: { SECRET: "op://v/i/" } },
        { references: { SECRET: "op://v/i/f" }, environmentId: "env" },
        { references: {} },
        { references: { "": "op://v/i/f" } },
        { references: { " ": "op://v/i/f" } },
        { references: { GOOD: "op://v/i/f", "": "op://v/i/f" } },
        { references: { GOOD: "op://v/i/f", " ": "op://v/i/f" } },
        { references: { SECRET: 123 } },
        { references: "op://v/i/f" },
        {},
        { environmentId: " " },
      ]) {
        expect(
          Result.isFailure(
            Schema.decodeUnknownResult(OnePassword.OnePasswordOptionsSchema)(options),
          ),
        ).toBe(true);
        const test = fixture();
        const result = yield* test
          .run(read, options as OnePassword.OnePasswordOptions)
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(OnePassword.OnePasswordSecretsError);
          expect(JSON.stringify(result.failure)).not.toContain("not-a-reference-private-value");
        }
        expect(test.calls.loads).toBe(0);
      }
    }),
  );

  check("rejects SDK-invalid references before creating a client without leaking the URI", () =>
    Effect.gen(function* () {
      const test = fixture({ validateError: new Error("private-parser-details") });
      const result = yield* test
        .run(read, { references: { ONEPASSWORD_TEST_SECRET: "op://v/i/f" } })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(OnePassword.OnePasswordReferenceError);
        expect((result.failure as OnePassword.OnePasswordReferenceError).reason).toBe(
          "InvalidReference",
        );
        expect(JSON.stringify(result.failure)).not.toContain("private-parser-details");
        expect(JSON.stringify(result.failure)).not.toContain("op://v/i/f");
      }
      expect(test.calls.configs).toEqual([]);
      expect(test.calls.references).toEqual([]);
    }),
  );

  check(
    "rejects partial, missing, and malformed reference results without exposing SDK errors",
    () =>
      Effect.gen(function* () {
        for (const response of [
          undefined,
          {},
          { error: { type: "fieldNotFound" as const } },
          { error: { type: "parsing" as const, message: "private-sdk-detail" } },
          {
            content: { secret: "private-secret", itemId: "i", vaultId: "v" },
            error: { type: "other" as const },
          },
        ]) {
          const test = fixture({
            referenceResponses: {
              "op://v/i/good": { content: { secret: "private-secret", itemId: "i", vaultId: "v" } },
              ...(response ? { "op://v/i/bad": response } : {}),
            },
          });
          const result = yield* test
            .run(Config.String("GOOD"), {
              references: {
                GOOD: "op://v/i/good",
                BAD: "op://v/i/bad",
              },
            })
            .pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(OnePassword.OnePasswordReferenceError);
            const error = result.failure as OnePassword.OnePasswordReferenceError;
            expect(error.configKey).toBe("BAD");
            expect(error.reason).toBe(response ? "ResolutionFailed" : "MissingResponse");
            expect(error.message).toContain("No partial config");
            expect(JSON.stringify(error)).not.toContain("private-");
            expect(JSON.stringify(error)).not.toContain("op://v/i/bad");
          }
          expect(test.calls.references.length).toBe(1);
        }
      }),
  );

  for (const operation of ["authenticate", "resolve"] as const) {
    check(`surfaces reference ${operation} rate limits without retries or leaked details`, () =>
      Effect.gen(function* () {
        const rateLimit = new SDK.RateLimitExceededError("private-rate-limit-details");
        const test = fixture(
          operation === "authenticate" ? { createError: rateLimit } : { resolveError: rateLimit },
        );
        const result = yield* test
          .run(read, { references: { ONEPASSWORD_TEST_SECRET: "op://v/i/f" } })
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(OnePassword.OnePasswordRateLimitError);
          const error = result.failure as OnePassword.OnePasswordRateLimitError;
          expect(error.operation).toBe(operation);
          expect(error.message).toContain("No automatic retry");
          expect(error.message).toContain("secret references");
          expect(JSON.stringify(error)).not.toContain("private-rate-limit-details");
        }
        expect(test.calls.configs.length).toBe(1);
        expect(test.calls.references.length).toBe(operation === "resolve" ? 1 : 0);
      }),
    );
  }

  check("does not interpret Environment values as references", () =>
    Effect.gen(function* () {
      const test = fixture({
        variables: [{ name: "ONEPASSWORD_TEST_SECRET", value: "op://v/i/f", masked: true }],
      });
      expect(yield* test.run(read)).toBe("op://v/i/f");
      expect(test.calls.references).toEqual([]);
    }),
  );

  check("loads masked, unmasked, and empty values once without changing process.env", () =>
    Effect.gen(function* () {
      const test = fixture();
      const before = process.env.ONEPASSWORD_TEST_SECRET;
      const values = yield* test.run(
        Effect.all({
          first: Config.Redacted("ONEPASSWORD_TEST_SECRET"),
          second: read,
          empty: Config.String("ONEPASSWORD_TEST_EMPTY"),
          visible: Config.String("ONEPASSWORD_TEST_PUBLIC"),
        }),
      );
      expect(Redacted.value(values.first)).toBe("secret-value");
      expect(values.second).toBe("secret-value");
      expect(values.empty).toBe("");
      expect(values.visible).toBe("development-id");
      expect(process.env.ONEPASSWORD_TEST_SECRET).toBe(before);
      expect(test.calls.environments).toEqual(["development-id"]);
      expect(test.calls.configs[0].auth).toBe("test-service-token");
      expect(test.calls.configs[0].integrationName).toBe("Alchemy");
    }),
  );

  check("service tokens take precedence over an explicit desktop account, including in CI", () =>
    withEnv(
      { CI: "true" },
      Effect.gen(function* () {
        const test = fixture();
        yield* test.run(read, { environmentId: "env", account: "Explicit Account" });
        expect(test.calls.configs[0].auth).toBe("test-service-token");
      }),
    ),
  );

  check("authorizes desktop access with an explicit account", () =>
    withEnv(
      { OP_SERVICE_ACCOUNT_TOKEN: undefined },
      Effect.gen(function* () {
        const test = fixture();
        yield* test.run(read, { environmentId: "env", account: "My Account" });
        expect(test.calls.configs[0].auth).toEqual(new SDK.DesktopAuth("My Account"));
      }),
    ),
  );

  check("declares only service-account credentials for environment authentication", () =>
    Effect.gen(function* () {
      const auth = yield* getAuthProvider<
        OnePassword.OnePasswordAuthConfig,
        OnePassword.OnePasswordResolvedCredentials
      >("1Password").pipe(Effect.provide(OnePassword.OnePasswordAuth));
      expect(auth.environment).toEqual([
        {
          name: "OP_SERVICE_ACCOUNT_TOKEN",
          required: true,
          secret: true,
          description: "Service account token for unattended access",
        },
      ]);
    }),
  );

  check("fails without prompting when CI has no token", () =>
    withEnv(
      { OP_SERVICE_ACCOUNT_TOKEN: undefined, CI: "true" },
      Effect.gen(function* () {
        const test = fixture();
        const result = yield* test
          .run(read, { environmentId: "env", account: "Explicit Account" })
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(String(result.failure)).toContain("OP_SERVICE_ACCOUNT_TOKEN");
        expect(test.calls.loads).toBe(0);
      }),
    ),
  );

  check("does not accept credentials injected by an earlier config provider", () =>
    withEnv(
      { OP_SERVICE_ACCOUNT_TOKEN: undefined, CI: "true" },
      Effect.gen(function* () {
        const test = fixture();
        const result = yield* test
          .run(read)
          .pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ OP_SERVICE_ACCOUNT_TOKEN: "injected" }),
            ),
            Effect.result,
          );
        expect(Result.isFailure(result)).toBe(true);
        expect(test.calls.loads).toBe(0);
      }),
    ),
  );

  check("skips SDK loading and option evaluation during auth discovery", () =>
    withEnv(
      { OP_SERVICE_ACCOUNT_TOKEN: undefined },
      Effect.gen(function* () {
        const test = fixture({ loadError: new Error("must not load") });
        yield* test
          .run(Effect.void, () => {
            throw new Error("must not resolve options");
          })
          .pipe(Effect.provideService(SuppressMissingProviderConfig, true));
        expect(test.calls.loads).toBe(0);
      }),
    ),
  );

  check("resolves stage callbacks independently and fetches fresh values on reevaluation", () =>
    Effect.gen(function* () {
      const test = fixture();
      const provider = OnePassword.Secrets(({ stage, stack }) => ({
        environmentId: `${stack.name}-${stage}`,
      }));
      const values = yield* Effect.all(
        [
          runStack([provider], Config.String("ONEPASSWORD_TEST_PUBLIC"), "dev"),
          runStack([provider], Config.String("ONEPASSWORD_TEST_PUBLIC"), "prod"),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.provideService(OnePasswordSdk, test.boundary));
      expect(values).toEqual(["1password-tests-dev", "1password-tests-prod"]);
      expect(test.calls.environments.length).toBe(2);
      yield* test.run(read);
      yield* test.run(read);
      expect(test.calls.environments.length).toBe(4);
    }),
  );

  check("preserves stack ordering, fallback, empty overrides, and process env precedence", () =>
    withEnv(
      { ONEPASSWORD_TEST_SECRET: "shell-value" },
      Effect.gen(function* () {
        const test = fixture();
        const base = ConfigProvider.layerAdd(
          ConfigProvider.fromEnv({
            env: { ONEPASSWORD_TEST_FALLBACK: "fallback", ONEPASSWORD_TEST_EMPTY: "earlier" },
          }),
          { asPrimary: true },
        );
        const provider = OnePassword.Secrets({ environmentId: "env" });
        const values = Effect.all({
          secret: read,
          empty: Config.String("ONEPASSWORD_TEST_EMPTY"),
          fallback: Config.String("ONEPASSWORD_TEST_FALLBACK"),
        });
        const first = yield* runStack([base, provider], values).pipe(
          Effect.provideService(OnePasswordSdk, test.boundary),
        );
        expect(first).toEqual({ secret: "shell-value", empty: "", fallback: "fallback" });
        const second = yield* runStack(
          [base, provider, Secrets.ProcessEnv({ disabled: true })],
          values,
        ).pipe(Effect.provideService(OnePasswordSdk, test.boundary));
        expect(second.secret).toBe("secret-value");
        const third = yield* runStack(
          [provider, base, Secrets.ProcessEnv({ disabled: true })],
          Config.String("ONEPASSWORD_TEST_EMPTY"),
        ).pipe(Effect.provideService(OnePasswordSdk, test.boundary));
        expect(third).toBe("earlier");
      }),
    ),
  );

  for (const operation of ["authenticate", "read"] as const) {
    check(
      `reports rate limits during ${operation} without retries, fallback, or secret leakage`,
      () =>
        Effect.gen(function* () {
          const error = new SDK.RateLimitExceededError("sensitive-token-and-secret");
          const test = fixture(
            operation === "authenticate" ? { createError: error } : { readError: error },
          );
          const result = yield* test
            .run(read, { environmentId: "rate-limited-env", account: "Desktop Account" })
            .pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure instanceof OnePassword.OnePasswordRateLimitError).toBe(true);
            const failure = result.failure as OnePassword.OnePasswordRateLimitError;
            expect(failure.operation).toBe(operation);
            expect(failure.message).toContain("op service-account ratelimit");
            expect(failure.message).toContain("daily");
            expect(failure.message).toContain("rate-limited-env");
            expect(JSON.stringify(failure)).not.toContain("sensitive-token-and-secret");
            expect(String(failure)).not.toContain("test-service-token");
          }
          expect(test.calls.configs.length).toBe(1);
          expect(test.calls.environments.length).toBe(operation === "read" ? 1 : 0);
        }),
    );
  }

  for (const [error, reason] of [
    [new SDK.AuthExpiredError("secret-in-error"), "AuthExpired"],
    [new SDK.DesktopSessionExpiredError("secret-in-error"), "DesktopSessionExpired"],
    [new Error("secret-in-error"), "SdkError"],
  ] as const) {
    check(`sanitizes ${reason} and does not retry or fall back`, () =>
      Effect.gen(function* () {
        const test = fixture({ createError: error });
        const result = yield* test.run(read).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure instanceof OnePassword.OnePasswordSecretsError).toBe(true);
          expect((result.failure as OnePassword.OnePasswordSecretsError).reason).toBe(reason);
          expect(JSON.stringify(result.failure)).not.toContain("secret-in-error");
        }
        expect(test.calls.configs.length).toBe(1);
        expect(test.calls.environments.length).toBe(0);
      }),
    );
  }

  check("sanitizes SDK import failures", () =>
    Effect.gen(function* () {
      const test = fixture({ loadError: new Error("sensitive-path") });
      const result = yield* test.run(read).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect((result.failure as OnePassword.OnePasswordSecretsError).operation).toBe(
          "initialize",
        );
        expect(JSON.stringify(result.failure)).not.toContain("sensitive-path");
      }
    }),
  );

  check("preserves quota guidance when a stack wraps the error as ConfigError", () =>
    Effect.gen(function* () {
      const test = fixture({ readError: new SDK.RateLimitExceededError("private-sdk-message") });
      let ran = false;
      const result = yield* runStack(
        [OnePassword.Secrets({ environmentId: "limited-env" })],
        Effect.sync(() => {
          ran = true;
        }),
      ).pipe(Effect.provideService(OnePasswordSdk, test.boundary), Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(ran).toBe(false);
      if (Result.isFailure(result)) {
        expect(result.failure instanceof Config.ConfigError).toBe(true);
        expect(String(result.failure)).toContain("op service-account ratelimit");
        expect(String(result.failure)).not.toContain("private-sdk-message");
      }
      expect(test.calls.environments).toEqual(["limited-env"]);
    }),
  );

  check("allows 60 seconds for desktop approval without retrying", () =>
    withEnv(
      { OP_SERVICE_ACCOUNT_TOKEN: undefined },
      Effect.gen(function* () {
        const test = fixture({ hang: "authenticate" });
        let completed = false;
        const fiber = yield* Effect.forkChild(
          test.run(read, { environmentId: "env", account: "My Account" }).pipe(
            Effect.result,
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true;
              }),
            ),
          ),
        );
        yield* TestClock.adjust("31 seconds");
        expect(completed).toBe(false);
        yield* TestClock.adjust("30 seconds");
        const result = yield* Fiber.join(fiber);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect((result.failure as OnePassword.OnePasswordSecretsError).reason).toBe("Timeout");
        expect(test.calls.configs.length).toBe(1);
      }),
    ),
  );

  for (const operation of ["initialize", "authenticate", "read", "resolve"] as const) {
    check(`bounds ${operation} with a sanitized timeout`, () =>
      Effect.gen(function* () {
        const test = fixture({ hang: operation });
        const fiber = yield* Effect.forkChild(
          test
            .run(
              read,
              operation === "resolve"
                ? {
                    references: { ONEPASSWORD_TEST_SECRET: "op://v/i/f" },
                  }
                : { environmentId: "development-id" },
            )
            .pipe(Effect.result),
        );
        yield* TestClock.adjust("31 seconds");
        const result = yield* Fiber.join(fiber);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect((result.failure as OnePassword.OnePasswordSecretsError).operation).toBe(operation);
          expect((result.failure as OnePassword.OnePasswordSecretsError).reason).toBe("Timeout");
        }
        expect(test.calls.loads).toBe(1);
      }),
    );
  }

  check("rejects blank Environment IDs before authentication", () =>
    Effect.gen(function* () {
      const test = fixture();
      const result = yield* test.run(read, { environmentId: " " }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(test.calls.loads).toBe(0);
    }),
  );

  check("allows empty Environments to fall back to earlier config", () =>
    Effect.gen(function* () {
      const test = fixture({ variables: [] });
      const value = yield* test
        .run(read)
        .pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: { ONEPASSWORD_TEST_SECRET: "fallback" } }),
          ),
        );
      expect(value).toBe("fallback");
    }),
  );

  check("rejects duplicate names without revealing their values", () =>
    Effect.gen(function* () {
      const test = fixture({
        variables: [
          { name: "DUPLICATE", value: "first-secret", masked: true },
          { name: "DUPLICATE", value: "second-secret", masked: true },
        ],
      });
      const result = yield* test.run(Effect.void).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(JSON.stringify(result.failure)).not.toContain("second-secret");
    }),
  );

  check("logs names but never values or credentials", () =>
    Effect.gen(function* () {
      const messages: string[] = [];
      const capture = Logger.make(({ message }) => {
        messages.push(String(message));
      });
      yield* fixture()
        .run(read)
        .pipe(
          Effect.provide(Logger.layer([capture])),
          Effect.provideService(MinimumLogLevel, "Debug"),
        );
      expect(messages.join("\n")).toContain("ONEPASSWORD_TEST_SECRET");
      expect(messages.join("\n")).not.toContain("secret-value");
      expect(messages.join("\n")).not.toContain("test-service-token");
      yield* fixture()
        .run(read, { references: { ONEPASSWORD_TEST_SECRET: "op://private-vault/item/field" } })
        .pipe(
          Effect.provide(Logger.layer([capture])),
          Effect.provideService(MinimumLogLevel, "Debug"),
        );
      expect(messages.join("\n")).not.toContain("resolved-secret");
      expect(messages.join("\n")).not.toContain("private-vault");
    }),
  );

  check("configures a desktop profile without contacting the SDK", () =>
    Effect.gen(function* () {
      const auth = yield* getAuthProvider<
        OnePassword.OnePasswordAuthConfig,
        OnePassword.OnePasswordResolvedCredentials
      >("1Password").pipe(Effect.provide(OnePassword.OnePasswordAuth));
      const config = yield* auth.configureWith!("test", {
        method: "desktop",
        values: { account: "My Account" },
      });
      expect(config).toEqual({ method: "desktop", account: "My Account" });
      const store = yield* ProfileStore;
      yield* store.createProfile("1password-test");
      yield* store.setProviderConfig("1password-test", "1Password", config);
      const credentials = yield* withEnv(
        { OP_SERVICE_ACCOUNT_TOKEN: undefined },
        resolveCredentials().pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ALCHEMY_PROFILE: "1password-test" }),
          ),
        ),
      );
      expect(credentials).toEqual({ method: "desktop", account: "My Account" });
      const invalid = yield* auth.configureWith!("test", {
        method: "desktop",
        values: { account: " " },
      }).pipe(Effect.result);
      expect(Result.isFailure(invalid)).toBe(true);
    }),
  );

  check("rejects a blank desktop selector before loading the SDK", () =>
    withEnv(
      { OP_SERVICE_ACCOUNT_TOKEN: undefined },
      Effect.gen(function* () {
        const result = yield* resolveCredentials(" ").pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
      }),
    ),
  );
});
