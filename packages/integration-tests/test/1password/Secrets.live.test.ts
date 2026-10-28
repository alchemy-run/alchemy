import * as OnePassword from "@alchemy.run/1password";
import { describe, expect, it } from "@alchemy.run/test";
import * as TestCore from "@alchemy.run/test/Core";
import { inMemoryState, Stack, Stage } from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

// Opt in explicitly: these reads consume service-account quota or display a
// desktop authorization prompt. The fixture Environment needs the variable
// ALCHEMY_ONEPASSWORD_TEST=ready. No Environment is created or modified.
const enabled = process.env.ONEPASSWORD_TEST_LIVE === "1";
const environmentId = process.env.ONEPASSWORD_TEST_ENVIRONMENT_ID;
const account = process.env.ONEPASSWORD_TEST_DESKTOP_ACCOUNT;
const reference = process.env.ONEPASSWORD_TEST_REFERENCE;

const readFixture = (options: OnePassword.OnePasswordOptions) =>
  TestCore.toEffect(
    Stack(
      "1password-live",
      {
        providers: Layer.empty,
        state: inMemoryState(),
        secrets: [OnePassword.Secrets(options)],
      },
      Config.Redacted("ALCHEMY_ONEPASSWORD_TEST").pipe(
        Effect.map((value) => expect(Redacted.value(value) === "ready").toBe(true)),
      ),
    ).pipe(Effect.provideService(Stage, "test")),
    { providers: Layer.empty, state: inMemoryState() },
  );

describe("1Password live Environment reads", { tags: ["live"] }, () => {
  it.live.skipIf(!enabled || !reference || !process.env.OP_SERVICE_ACCOUNT_TOKEN)(
    "resolves a vault reference with a service account",
    () => readFixture({ references: { ALCHEMY_ONEPASSWORD_TEST: reference! } }),
    { timeout: 120_000, retry: 0, exclusive: true },
  );

  it.live.skipIf(!enabled || !environmentId || !process.env.OP_SERVICE_ACCOUNT_TOKEN)(
    "reads an Environment with a service account",
    () => readFixture({ environmentId: environmentId! }),
    { timeout: 120_000, retry: 0, exclusive: true },
  );

  it.live.skipIf(!enabled || !environmentId || !account)(
    "reads an Environment after desktop authorization",
    () =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const previous = { token: process.env.OP_SERVICE_ACCOUNT_TOKEN, ci: process.env.CI };
          delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
          process.env.CI = "false";
          return previous;
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous.token === undefined) delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
            else process.env.OP_SERVICE_ACCOUNT_TOKEN = previous.token;
            if (previous.ci === undefined) delete process.env.CI;
            else process.env.CI = previous.ci;
          }),
      ).pipe(
        Effect.andThen(readFixture({ environmentId: environmentId!, account })),
        Effect.scoped,
      ),
    { timeout: 120_000, retry: 0, exclusive: true },
  );
});
