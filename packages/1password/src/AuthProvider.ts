import { AuthError, AuthProviderLayer, type ConfigureField } from "alchemy/Auth/AuthProvider";
import { getEnvRedacted } from "alchemy/Auth/Env";
import { resolveProviderConfig } from "alchemy/Auth/Resolve";
import {
  collectFieldValues,
  storedValueText,
  validateFieldValues,
} from "alchemy/Auth/StoredAuthProvider";
import { CredentialsConfig } from "alchemy/Secrets/Provider";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/** Service account token used for unattended access. */
export const OP_SERVICE_ACCOUNT_TOKEN_ENV = "OP_SERVICE_ACCOUNT_TOKEN";

export const OnePasswordAuthConfigSchema = Schema.Struct({
  method: Schema.Literal("desktop"),
  account: Schema.NonEmptyString,
});
export type OnePasswordAuthConfig = typeof OnePasswordAuthConfigSchema.Type;

export type OnePasswordResolvedCredentials =
  | { readonly method: "service-account"; readonly token: Redacted.Redacted<string> }
  | { readonly method: "desktop"; readonly account: string };

const fields: ReadonlyArray<ConfigureField> = [
  {
    name: "account",
    label: "1Password account name or UUID",
    description: "Use the account name shown in the 1Password desktop app sidebar, or its UUID.",
    validate: (value) =>
      value.trim().length === 0 ? "An account name or UUID is required." : undefined,
  },
];

const configure = collectFieldValues(fields).pipe(
  Effect.map((values): OnePasswordAuthConfig => ({
    method: "desktop",
    account: storedValueText(values.account)!.trim(),
  })),
);

const tokenFromEnvironment = getEnvRedacted(OP_SERVICE_ACCOUNT_TOKEN_ENV).pipe(
  Effect.map((token) =>
    token !== undefined && Redacted.value(token).length > 0
      ? { method: "service-account" as const, token }
      : undefined,
  ),
);

const requireLocal = Config.Boolean("CI").pipe(
  Config.withDefault(false),
  Effect.mapError(() => AuthError.make({ message: "1Password: CI must be a boolean." })),
  Effect.flatMap((ci) =>
    ci
      ? Effect.fail(
          AuthError.make({
            message:
              "1Password requires OP_SERVICE_ACCOUNT_TOKEN in CI. Grant the service account read access to the selected Environment.",
          }),
        )
      : Effect.void,
  ),
);

const preferServiceAccount = <E, R>(desktop: Effect.Effect<OnePasswordResolvedCredentials, E, R>) =>
  Effect.gen(function* () {
    const token = yield* tokenFromEnvironment;
    if (token !== undefined) return token;
    yield* requireLocal;
    return yield* desktop;
  });

const readEnvironment = Effect.gen(function* () {
  const token = yield* tokenFromEnvironment;
  if (token !== undefined) return token;
  return yield* AuthError.make({
    message: "1Password requires OP_SERVICE_ACCOUNT_TOKEN in CI.",
  });
});

/** Store only the desktop account selector; 1Password manages authorization. */
export const OnePasswordAuth = AuthProviderLayer<
  OnePasswordAuthConfig,
  OnePasswordResolvedCredentials
>()("1Password", {
  configSchema: OnePasswordAuthConfigSchema,
  configure: () => configure,
  configureMethods: [{ method: "desktop", fields }],
  configureWith: (_, input) =>
    input.method === "desktop"
      ? validateFieldValues("1Password", fields, input.values).pipe(
          Effect.map((values): OnePasswordAuthConfig => ({
            method: "desktop",
            account: storedValueText(values.account)!.trim(),
          })),
        )
      : Effect.fail(
          AuthError.make({
            message:
              "1Password: use method 'desktop' with --set account=<name-or-uuid>. In CI set OP_SERVICE_ACCOUNT_TOKEN.",
          }),
        ),
  login: () => configure,
  logout: () => Effect.void,
  read: (_, config) => Effect.succeed({ method: "desktop", account: config.account }),
  details: (_, config) =>
    Effect.succeed({
      lines: [
        { key: "method", value: "desktop" },
        { key: "account", value: config.account },
      ],
    }),
  readEnvironment,
  environment: [
    {
      name: OP_SERVICE_ACCOUNT_TOKEN_ENV,
      required: true,
      secret: true,
      description: "Service account token for unattended access",
    },
  ],
});

/** Resolve credentials independently of secrets loaded by earlier providers. */
export const resolveCredentials = (account?: string) =>
  preferServiceAccount(
    Effect.gen(function* () {
      if (account !== undefined) {
        if (!account.trim())
          return yield* AuthError.make({
            message: "1Password: account must be a non-empty desktop account name or UUID.",
          });
        return { method: "desktop" as const, account: account.trim() };
      }
      const resolved = yield* resolveProviderConfig<
        OnePasswordAuthConfig,
        OnePasswordResolvedCredentials
      >("1Password").pipe(Effect.provide(OnePasswordAuth));
      return yield* resolved.resolve;
    }),
  ).pipe(Effect.provide(CredentialsConfig));
