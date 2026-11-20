import * as ProtonPass from "@alchemy.run/proton-pass";
import { resolveCredentials } from "@alchemy.run/proton-pass/AuthProvider";
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
    deploy({ stack: Stack("proton-pass-secrets", { ...options, secrets }, body), stage }),
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

describe("Proton Pass offline", { tags: ["unit", "local"] }, () => {
  it.effect("auth discovery does not evaluate options or run the CLI", () =>
    runStack(
      [
        ProtonPass.Item(() => {
          throw new Error("options must not be evaluated");
        }),
        ProtonPass.SecretReferences(() => {
          throw new Error("options must not be evaluated");
        }),
      ],
      Effect.void,
    ).pipe(Effect.provideService(SuppressMissingProviderConfig, true)),
  );

  it.effect("configures CLI-session and token authentication offline", () =>
    TestCore.toEffect(
      Effect.gen(function* () {
        const auth = yield* getAuthProvider<
          ProtonPass.ProtonPassAuthConfig,
          ProtonPass.ProtonPassResolvedCredentials
        >("ProtonPass").pipe(Effect.provide(ProtonPass.ProtonPassAuth));
        expect(auth.environment?.map((entry) => entry.name)).toEqual([
          "PROTON_PASS_PERSONAL_ACCESS_TOKEN",
        ]);
        const session = yield* auth.configureWith!("testing", {
          method: "cli-session",
          values: {},
        });
        expect(session).toEqual({ method: "cli-session" });
        const invalid = yield* auth.configureWith!("testing", {
          method: "personal-access-token",
          values: { token: "not-a-token" },
        }).pipe(Effect.result);
        expect(Result.isFailure(invalid)).toBe(true);
        const stored = yield* auth.configureWith!("testing", {
          method: "personal-access-token",
          values: { token: " pst_stored::key " },
        });
        expect(stored).toEqual({ method: "personal-access-token", token: "pst_stored::key" });
        const credentials = yield* auth.read("testing", Effect.succeed(stored));
        expect(credentials.method).toBe("personal-access-token");
        if (credentials.method === "personal-access-token") {
          expect(Redacted.value(credentials.token) === "pst_stored::key").toBe(true);
        }
        const details = yield* auth.details("testing", Effect.succeed(stored));
        expect(JSON.stringify(details)).not.toContain("pst_stored");
      }).pipe(Effect.provide(Interaction.layerNonInteractive())),
      options,
    ),
  );

  it.effect(
    "the token comes from the shell even when earlier config supplies one",
    () =>
      withEnv(
        { PROTON_PASS_PERSONAL_ACCESS_TOKEN: "pst_shell::key" },
        TestCore.toEffect(
          Effect.gen(function* () {
            const credentials = yield* resolveCredentials.pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromUnknown({
                  PROTON_PASS_PERSONAL_ACCESS_TOKEN: "pst_injected::key",
                }),
              ),
            );
            expect(credentials.method).toBe("personal-access-token");
            if (credentials.method === "personal-access-token") {
              expect(Redacted.value(credentials.token) === "pst_shell::key").toBe(true);
            }
          }),
          options,
        ),
      ),
    { exclusive: true, retry: 0 },
  );

  it.effect(
    "reports a missing CLI without leaking the token",
    () =>
      withEnv(
        { PATH: "/nonexistent", PROTON_PASS_PERSONAL_ACCESS_TOKEN: "pst_audit::secret-key" },
        Effect.gen(function* () {
          const result = yield* runStack(
            [ProtonPass.SecretReferences({ references: { A: "pass://v/i/f" } })],
            Effect.void,
          ).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(providerError(result.failure)).toBeInstanceOf(
              ProtonPass.ProtonPassCliNotFoundError,
            );
            expect(String(result.failure)).not.toContain("secret-key");
          }
        }),
      ),
    { exclusive: true, retry: 0 },
  );
});

// Read-only fixtures. Enabling live tests requires a vault holding a custom
// item whose fields are listed in the README. Missing fixture configuration
// fails explicitly once opted in, rather than silently passing.
const live = process.env.PROTON_PASS_TEST_LIVE === "1";
const hasCli = live && !!Bun.which("pass-cli");
const tokenPath = live && !!process.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN;
const sessionPath = live && !process.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN;
const vault = Config.String("PROTON_PASS_TEST_VAULT").pipe(Config.withDefault("alchemy-test"));
const item = "alchemy-fixture";

const ready = (key: string, expected = "ready") =>
  Config.Redacted(key).pipe(
    Effect.map((value) => expect(Redacted.value(value) === expected).toBe(true)),
  );

const roundTrip = Effect.gen(function* () {
  const name = yield* vault;
  yield* runStack(
    [
      ProtonPass.Item(({ stage }) => {
        expect(stage).toBe("audit");
        return { vault: name, item };
      }),
      ProtonPass.SecretReferences({
        references: {
          FROM_REFERENCE: `pass://${name}/${item}/ALCHEMY_PROTON_PASS_TEST`,
          ALIAS: `pass://${name}/${item}/ALCHEMY_PROTON_PASS_TEST`,
          SECTIONED: `pass://${name}/${item}/Staging.API_KEY`,
        },
      }),
      Secrets.ProcessEnv({ disabled: true }),
    ],
    Effect.gen(function* () {
      // From the item, under field names.
      yield* ready("ALCHEMY_PROTON_PASS_TEST");
      yield* ready("API_KEY", "staging-ready");
      yield* ready("MULTILINE", 'line one\nline "two" = x');
      yield* ready("EMPTY", "");
      // From references, under the chosen keys.
      yield* ready("FROM_REFERENCE");
      yield* ready("ALIAS");
      yield* ready("SECTIONED", "staging-ready");
    }),
    "audit",
  );
  // A login item: its custom fields load, its built-in fields don't.
  yield* runStack(
    [
      ProtonPass.Item({ vault: name, item: "alchemy-login" }),
      Secrets.ProcessEnv({ disabled: true }),
    ],
    Effect.gen(function* () {
      yield* ready("LOGIN_EXTRA", "extra-ready");
      const password = yield* Config.option(Config.String("password"));
      expect(password._tag).toBe("None");
    }),
  );
});

const failures = Effect.gen(function* () {
  const name = yield* vault;
  for (const [reference, errorType] of [
    [`pass://${name}/${item}/alchemy-audit-missing-field`, "fieldNotFound"],
    [`pass://${name}/alchemy-audit-missing-item/x`, "itemNotFound"],
    ["not-a-reference", "parsing"],
  ] as const) {
    let ran = false;
    const result = yield* runStack(
      [
        ProtonPass.SecretReferences({
          references: {
            GOOD: `pass://${name}/${item}/ALCHEMY_PROTON_PASS_TEST`,
            MISSING: reference,
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
      const error = providerError(result.failure);
      expect(error).toBeInstanceOf(ProtonPass.ProtonPassReferenceError);
      expect((error as ProtonPass.ProtonPassReferenceError).errorType).toBe(errorType);
      const message = String(result.failure);
      expect(message).toContain("config key 'MISSING'");
      expect(message).toContain("No partial config");
      expect(message.includes(reference)).toBe(false);
      expect(message.includes("ready")).toBe(false);
    }
  }
  const missingItem = yield* runStack(
    [ProtonPass.Item({ vault: name, item: "alchemy-audit-missing-item" })],
    Effect.void,
  ).pipe(Effect.result);
  expect(Result.isFailure(missingItem)).toBe(true);
  if (Result.isFailure(missingItem)) {
    expect(providerError(missingItem.failure)).toBeInstanceOf(ProtonPass.ProtonPassItemError);
  }
});

describe("Proton Pass live secrets", { tags: ["live"] }, () => {
  it.live.skipIf(!hasCli || !sessionPath)(
    "loads an item and references through the CLI's own session",
    () => roundTrip,
    { timeout: 120_000, retry: 0, exclusive: true },
  );

  it.live.skipIf(!hasCli || !sessionPath)(
    "fails the whole load on a missing or malformed reference without leaking values",
    () => failures,
    { timeout: 120_000, retry: 0, exclusive: true },
  );

  it.live.skipIf(!hasCli || !tokenPath)(
    "loads through a personal access token in a temporary session",
    () =>
      Effect.gen(function* () {
        yield* roundTrip;
        yield* failures;
      }),
    { timeout: 180_000, retry: 0, exclusive: true },
  );

  it.live.skipIf(!hasCli || !live)(
    "rejects a malformed personal access token without leaking it",
    () =>
      withEnv(
        { PROTON_PASS_PERSONAL_ACCESS_TOKEN: "pst_invalid-audit-token::nope" },
        Effect.gen(function* () {
          const result = yield* runStack(
            [ProtonPass.SecretReferences({ references: { A: "pass://v/i/f" } })],
            Effect.void,
          ).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(providerError(result.failure)).toBeInstanceOf(ProtonPass.ProtonPassAuthError);
            expect(String(result.failure)).not.toContain("invalid-audit-token");
          }
        }),
      ),
    { timeout: 60_000, retry: 0, exclusive: true },
  );
});
