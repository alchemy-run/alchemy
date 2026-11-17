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

// The stack reports a secrets provider's failure as a ConfigError; return the provider's own error.
const providerError = (error: unknown) =>
  error instanceof Config.ConfigError && error.cause._tag === "SourceError"
    ? error.cause.cause
    : error;

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

describe("1Password offline", { tags: ["unit", "local"] }, () => {
  it.effect("auth discovery does not evaluate options or authenticate", () =>
    runStack(
      [
        OnePassword.Environment(() => {
          throw new Error("options must not be evaluated");
        }),
        OnePassword.SecretReferences(() => {
          throw new Error("options must not be evaluated");
        }),
      ],
      Effect.void,
    ).pipe(Effect.provideService(SuppressMissingProviderConfig, true)),
  );

  it.effect(
    "configures desktop and service-account authentication offline and rejects blank selectors",
    () =>
      TestCore.toEffect(
        Effect.gen(function* () {
          const auth = yield* getAuthProvider<
            OnePassword.OnePasswordAuthConfig,
            OnePassword.OnePasswordResolvedCredentials
          >("1Password").pipe(Effect.provide(OnePassword.OnePasswordAuth));
          expect(auth.environment?.map((entry) => entry.name)).toEqual([
            "OP_SERVICE_ACCOUNT_TOKEN",
          ]);
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
          const stored = yield* auth.configureWith!("testing", {
            method: "service-account",
            values: { token: " ops_stored " },
          });
          expect(stored).toEqual({ method: "service-account", token: "ops_stored" });
          const credentials = yield* auth.read("testing", Effect.succeed(stored));
          expect(credentials.method).toBe("service-account");
          if (credentials.method === "service-account") {
            expect(Redacted.value(credentials.token) === "ops_stored").toBe(true);
          }
          const details = yield* auth.details("testing", Effect.succeed(stored));
          expect(JSON.stringify(details)).not.toContain("ops_stored");
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
            [OnePassword.Environment({ environmentId: "unused", account: "Must Not Prompt" })],
            Effect.void,
          ).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(providerError(result.failure)).toBeInstanceOf(OnePassword.OnePasswordSdkError);
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
    "loads an Environment and vault references side by side",
    () =>
      Effect.gen(function* () {
        yield* Config.Redacted("OP_SERVICE_ACCOUNT_TOKEN");
        const environmentId = yield* Config.String("ONEPASSWORD_TEST_ENVIRONMENT_ID");
        const reference = yield* Config.String("ONEPASSWORD_TEST_REFERENCE");
        // An Environment and vault references, side by side in one list.
        yield* runStack(
          [
            OnePassword.Environment(({ stage }) => {
              expect(stage).toBe("audit");
              return { environmentId, account: "Service Token Takes Precedence" };
            }),
            OnePassword.SecretReferences({
              references: { FROM_REFERENCE: reference, ALIAS: reference },
            }),
            Secrets.ProcessEnv({ disabled: true }),
          ],
          Effect.gen(function* () {
            yield* fixtureValue;
            for (const key of ["FROM_REFERENCE", "ALIAS"]) {
              expect(Redacted.value(yield* Config.Redacted(key)) === "ready").toBe(true);
            }
          }),
          "audit",
        );
      }),
    { timeout: 120_000, retry: 0, exclusive: true },
  );

  it.live.skipIf(!serviceAccount)(
    "fails the whole load on a missing or malformed reference without leaking values",
    () =>
      Effect.gen(function* () {
        yield* Config.Redacted("OP_SERVICE_ACCOUNT_TOKEN");
        const reference = yield* Config.String("ONEPASSWORD_TEST_REFERENCE");
        const missing = reference.split("?")[0].replace(/[^/]+$/, "alchemy-audit-missing-field");
        let ran = false;
        const result = yield* runStack(
          [
            OnePassword.SecretReferences({
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
          expect(providerError(result.failure)).toBeInstanceOf(
            OnePassword.OnePasswordReferenceError,
          );
          const message = String(result.failure);
          expect(message).toContain("config key 'MISSING'");
          expect(message).toContain("No partial config");
          expect(message.includes(reference)).toBe(false);
          expect(message.includes(missing)).toBe(false);
          expect(message.includes("ready")).toBe(false);
        }
        // Malformed references are not checked ahead of time; 1Password rejects them at load.
        const malformed = yield* runStack(
          [OnePassword.SecretReferences({ references: { MALFORMED: "not-a-reference" } })],
          Effect.void,
        ).pipe(Effect.result);
        expect(Result.isFailure(malformed)).toBe(true);
        if (Result.isFailure(malformed)) {
          expect(providerError(malformed.failure)).toBeInstanceOf(
            OnePassword.OnePasswordReferenceError,
          );
          expect(String(malformed.failure)).toContain("config key 'MALFORMED'");
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
        // Two entries in one stack, then a second stack: the desktop app
        // asks the user to authorize Alchemy once for the whole process.
        yield* runStack(
          [
            OnePassword.Environment({ environmentId, account }),
            OnePassword.Environment({ environmentId, account }),
            Secrets.ProcessEnv({ disabled: true }),
          ],
          fixtureValue,
        );
        yield* runStack(
          [
            OnePassword.Environment({ environmentId, account }),
            Secrets.ProcessEnv({ disabled: true }),
          ],
          fixtureValue,
        );
        const unknown = yield* runStack(
          [OnePassword.Environment({ environmentId, account: "alchemy-audit-no-such-account" })],
          Effect.void,
        ).pipe(Effect.result);
        expect(Result.isFailure(unknown)).toBe(true);
        if (Result.isFailure(unknown)) {
          expect(providerError(unknown.failure)).toBeInstanceOf(
            OnePassword.OnePasswordAccountNotFoundError,
          );
          expect(String(unknown.failure)).toContain(
            "has no account 'alchemy-audit-no-such-account'",
          );
        }
      }),
    { timeout: 120_000, retry: 0, exclusive: true },
  );
});
