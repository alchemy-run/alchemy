import * as SDK from "@1password/sdk";
import * as OnePassword from "@alchemy.run/1password";
import { resolveCredentials } from "@alchemy.run/1password/AuthProvider";
import { describe, expect, it } from "@alchemy.run/test";
import * as TestCore from "@alchemy.run/test/Core";
import { inMemoryState, Secrets, Stack, type StackSecrets } from "alchemy";
import { getAuthProvider } from "alchemy/Auth/AuthProvider";
import { SuppressMissingProviderConfig } from "alchemy/Auth/Profile";
import { deploy } from "alchemy/Deploy";
import * as Interaction from "alchemy/Interaction";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const options = { providers: Layer.empty, state: inMemoryState() };

// Config is loaded while the stack is evaluated. No cloud resources or secret
// values are returned as stack outputs, and state stays in memory.
const runStack = <A>(
  secrets: StackSecrets,
  body: Effect.Effect<A, Config.ConfigError>,
  stage = "test",
) =>
  TestCore.toEffect(
    deploy({ stack: Stack("1password-secrets", { ...options, secrets }, body), stage }),
    options,
  );

// Tests using this helper hold the process-wide exclusive lock. Never change CI:
// profile storage and migration use it to choose their behavior.
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

describe("1Password offline validation", { tags: ["unit", "local"] }, () => {
  it("validates references against the real SDK parser", () => {
    for (const reference of [
      "op://vault/item/field",
      "op://My Vault/My Item/My Section/My Field",
      "op://vault/item/a.b_c-d",
      "op://vault/item/field?attribute=otp",
      "op://vault/item/field?ssh-format=openssh",
    ]) {
      expect(Schema.decodeUnknownSync(OnePassword.SecretReference)(reference)).toBe(reference);
      expect(() => SDK.Secrets.validateSecretReference(reference)).not.toThrow();
    }
    for (const reference of [
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
    ]) {
      expect(
        Result.isFailure(Schema.decodeUnknownResult(OnePassword.SecretReference)(reference)),
      ).toBe(true);
    }
  });

  it.effect("rejects invalid options before authentication without retaining their input", () =>
    Effect.gen(function* () {
      for (const supplied of [
        { references: { SECRET: "private-invalid-reference" } },
        { references: { SECRET: "op://v/i/" } },
        { references: { SECRET: "op://v/i/f" }, environmentId: "env" },
        { references: {} },
        { references: { "": "op://v/i/f" } },
        { references: { " ": "op://v/i/f" } },
        { references: { GOOD: "op://v/i/f", "": "op://v/i/f" } },
        { references: { SECRET: 123 } },
        { references: "op://v/i/f" },
        {},
        { environmentId: " " },
        { environmentId: "env", account: " " },
      ]) {
        expect(
          Result.isFailure(
            Schema.decodeUnknownResult(OnePassword.OnePasswordOptionsSchema)(supplied),
          ),
        ).toBe(true);
        const result = yield* runStack(
          [OnePassword.Secrets(supplied as OnePassword.OnePasswordOptions)],
          Effect.void,
        ).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(String(result.failure)).toContain("specify exactly one");
          expect(String(result.failure)).not.toContain("private-invalid-reference");
        }
      }
    }),
  );

  it.effect("auth discovery does not evaluate options or authenticate", () =>
    runStack(
      [
        OnePassword.Secrets(() => {
          throw new Error("options must not be evaluated");
        }),
      ],
      Effect.void,
    ).pipe(Effect.provideService(SuppressMissingProviderConfig, true)),
  );

  it.effect("configures desktop authentication offline and rejects blank selectors", () =>
    TestCore.toEffect(
      Effect.gen(function* () {
        const auth = yield* getAuthProvider<
          OnePassword.OnePasswordAuthConfig,
          OnePassword.OnePasswordResolvedCredentials
        >("1Password").pipe(Effect.provide(OnePassword.OnePasswordAuth));
        expect(auth.environment?.map((entry) => entry.name)).toEqual(["OP_SERVICE_ACCOUNT_TOKEN"]);
        const config = yield* auth.configureWith!("testing", {
          method: "desktop",
          values: { account: " My Account " },
        });
        expect(config).toEqual({ method: "desktop", account: "My Account" });
        const invalid = yield* auth.configureWith!("testing", {
          method: "desktop",
          values: { account: " " },
        }).pipe(Effect.result);
        expect(Result.isFailure(invalid)).toBe(true);
      }).pipe(Effect.provide(Interaction.layerNonInteractive())),
      options,
    ),
  );

  it.effect(
    "credentials come from the shell even when earlier config supplies a token",
    () =>
      withEnv(
        { OP_SERVICE_ACCOUNT_TOKEN: "shell-token" },
        TestCore.toEffect(
          Effect.gen(function* () {
            const credentials = yield* resolveCredentials("Unused Desktop Account").pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromUnknown({ OP_SERVICE_ACCOUNT_TOKEN: "injected-token" }),
              ),
            );
            expect(credentials.method).toBe("service-account");
            if (credentials.method === "service-account") {
              expect(Redacted.value(credentials.token) === "shell-token").toBe(true);
            }
          }),
          options,
        ),
      ),
    { exclusive: true, retry: 0 },
  );

  it.live(
    "sanitizes a real SDK authentication rejection without falling back to desktop",
    () =>
      withEnv(
        { OP_SERVICE_ACCOUNT_TOKEN: "invalid-audit-token" },
        Effect.gen(function* () {
          const result = yield* runStack(
            [OnePassword.Secrets({ environmentId: "unused", account: "Must Not Prompt" })],
            Effect.void,
          ).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(String(result.failure)).toContain("could not authenticate");
            expect(String(result.failure)).not.toContain("invalid-audit-token");
          }
        }),
      ),
    { exclusive: true, retry: 0, timeout: 45_000 },
  );
});

// These are read-only fixtures. Enabling live tests requires an Environment
// with ALCHEMY_ONEPASSWORD_TEST=ready and a vault reference whose value is ready.
// Missing fixtures fail explicitly once opted in, rather than silently passing.
const live = process.env.ONEPASSWORD_TEST_LIVE === "1";
const desktop = !!process.env.ONEPASSWORD_TEST_DESKTOP_ACCOUNT;
const serviceAccount = live && (!desktop || !!process.env.OP_SERVICE_ACCOUNT_TOKEN);
const desktopUnavailable =
  !!process.env.OP_SERVICE_ACCOUNT_TOKEN ||
  ["true", "1", "yes", "on"].includes(process.env.CI?.toLowerCase() ?? "");
const fixtureValue = Config.Redacted("ALCHEMY_ONEPASSWORD_TEST").pipe(
  Effect.map((value) => expect(Redacted.value(value) === "ready").toBe(true)),
);

describe("1Password live secrets", { tags: ["live"] }, () => {
  it.live.skipIf(!serviceAccount)(
    "loads an Environment through a stage-dependent stack provider",
    () =>
      Effect.gen(function* () {
        yield* Config.Redacted("OP_SERVICE_ACCOUNT_TOKEN");
        const environmentId = yield* Config.String("ONEPASSWORD_TEST_ENVIRONMENT_ID");
        yield* runStack(
          [
            OnePassword.Secrets(({ stage }) => {
              expect(stage).toBe("audit");
              return { environmentId, account: "Service Token Takes Precedence" };
            }),
            Secrets.ProcessEnv({ disabled: true }),
          ],
          fixtureValue,
          "audit",
        );
      }),
    { timeout: 120_000, retry: 0, exclusive: true },
  );

  it.live.skipIf(!serviceAccount)(
    "resolves duplicate references and preserves stack precedence",
    () =>
      Effect.gen(function* () {
        yield* Config.Redacted("OP_SERVICE_ACCOUNT_TOKEN");
        const reference = yield* Config.String("ONEPASSWORD_TEST_REFERENCE");
        const provider = OnePassword.Secrets({
          references: {
            ALCHEMY_ONEPASSWORD_TEST: reference,
            ALIAS: reference,
          },
        });
        const fallback = ConfigProvider.layerAdd(
          ConfigProvider.fromEnv({
            env: {
              ALCHEMY_ONEPASSWORD_TEST: "earlier",
              FALLBACK: "fallback",
            },
          }),
          { asPrimary: true },
        );
        yield* withEnv(
          { ALCHEMY_ONEPASSWORD_TEST: "shell" },
          Effect.gen(function* () {
            yield* runStack(
              [fallback, provider, Secrets.ProcessEnv({ disabled: true })],
              Effect.gen(function* () {
                yield* fixtureValue;
                const alias = yield* Config.Redacted("ALIAS");
                expect(Redacted.value(alias) === "ready").toBe(true);
                expect(yield* Config.String("FALLBACK")).toBe("fallback");
                expect(
                  yield* Config.String("ALCHEMY_ONEPASSWORD_TEST").pipe(
                    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
                  ),
                ).toBe("shell");
              }),
            );
            yield* runStack(
              [provider],
              Config.Redacted("ALCHEMY_ONEPASSWORD_TEST").pipe(
                Effect.map((value) => expect(Redacted.value(value) === "shell").toBe(true)),
              ),
            );
            yield* runStack(
              [provider, fallback, Secrets.ProcessEnv({ disabled: true })],
              Config.Redacted("ALCHEMY_ONEPASSWORD_TEST").pipe(
                Effect.map((value) => expect(Redacted.value(value) === "earlier").toBe(true)),
              ),
            );
          }),
        );
      }),
    { timeout: 120_000, retry: 0, exclusive: true },
  );

  it.live.skipIf(!serviceAccount)(
    "rejects a real partially failing reference batch without leaking values",
    () =>
      Effect.gen(function* () {
        yield* Config.Redacted("OP_SERVICE_ACCOUNT_TOKEN");
        const reference = yield* Config.String("ONEPASSWORD_TEST_REFERENCE");
        const missing = reference.split("?")[0].replace(/[^/]+$/, "alchemy-audit-missing-field");
        let ran = false;
        const result = yield* runStack(
          [
            OnePassword.Secrets({
              references: {
                GOOD: reference,
                MISSING: missing,
              },
            }),
          ],
          Effect.sync(() => {
            ran = true;
          }),
        ).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(ran).toBe(false);
        if (Result.isFailure(result)) {
          const message = String(result.failure);
          expect(message).toContain("config key 'MISSING'");
          expect(message).toContain("No partial config");
          expect(message.includes(reference)).toBe(false);
          expect(message.includes(missing)).toBe(false);
          expect(message.includes("ready")).toBe(false);
        }
      }),
    { timeout: 120_000, retry: 0, exclusive: true },
  );

  it.live.skipIf(!live || !desktop || desktopUnavailable)(
    "reads an Environment after desktop authorization",
    () =>
      Effect.gen(function* () {
        const environmentId = yield* Config.String("ONEPASSWORD_TEST_ENVIRONMENT_ID");
        const account = yield* Config.String("ONEPASSWORD_TEST_DESKTOP_ACCOUNT");
        yield* runStack(
          [OnePassword.Secrets({ environmentId, account }), Secrets.ProcessEnv({ disabled: true })],
          fixtureValue,
        );
      }),
    { timeout: 120_000, retry: 0, exclusive: true },
  );
});
