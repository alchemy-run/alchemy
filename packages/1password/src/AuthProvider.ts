import { AuthError, AuthProviderLayer, type ConfigureField } from "alchemy/Auth/AuthProvider";
import { getEnvRedacted, mapPromptCancellation } from "alchemy/Auth/Env";
import { resolveProviderConfig } from "alchemy/Auth/Resolve";
import {
  collectFieldValues,
  storedValueText,
  validateFieldValues,
} from "alchemy/Auth/StoredAuthProvider";
import * as Interaction from "alchemy/Interaction";
import { CredentialsConfig } from "alchemy/Secrets/Provider";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/** Service account token used for unattended access. */
export const OP_SERVICE_ACCOUNT_TOKEN_ENV = "OP_SERVICE_ACCOUNT_TOKEN";

const PROVIDER_NAME = "1Password";

/**
 * A stored 1Password profile entry: a desktop account selector (the desktop
 * app holds the authorization), or a service account token.
 */
export const OnePasswordAuthConfigSchema = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("desktop"),
    account: Schema.NonEmptyString,
  }),
  Schema.Struct({
    method: Schema.Literal("service-account"),
    token: Schema.NonEmptyString,
  }),
]);
export type OnePasswordAuthConfig = typeof OnePasswordAuthConfigSchema.Type;

export type OnePasswordResolvedCredentials =
  | { readonly method: "service-account"; readonly token: Redacted.Redacted<string> }
  | { readonly method: "desktop"; readonly account: string };

const desktopFields: ReadonlyArray<ConfigureField> = [
  {
    name: "account",
    label: "1Password account name or UUID",
    description: "Use the account name shown in the 1Password desktop app sidebar, or its UUID.",
    validate: (value) =>
      value.trim().length === 0 ? "An account name or UUID is required." : undefined,
  },
];

const serviceAccountFields: ReadonlyArray<ConfigureField> = [
  {
    name: "token",
    label: "1Password service account token",
    description: "Grant the service account read access to the Environments and vaults you load.",
    secret: true,
    validate: (value) => (value.trim().length === 0 ? "A token is required." : undefined),
  },
];

const toConfig = (
  method: OnePasswordAuthConfig["method"],
  values: Record<string, string | Redacted.Redacted<string> | undefined>,
): OnePasswordAuthConfig =>
  method === "desktop"
    ? { method, account: storedValueText(values.account)!.trim() }
    : { method, token: storedValueText(values.token)!.trim() };

const fieldsOf = (method: OnePasswordAuthConfig["method"]) =>
  method === "desktop" ? desktopFields : serviceAccountFields;

const configure = Interaction.select({
  message: "1Password authentication method",
  options: [
    {
      value: "desktop" as const,
      label: "Desktop app",
      description: "Authorize through the 1Password desktop app",
    },
    {
      value: "service-account" as const,
      label: "Service account",
      description: "Store a service account token in this profile",
    },
  ],
}).pipe(
  mapPromptCancellation,
  Effect.flatMap((method) =>
    collectFieldValues(fieldsOf(method)).pipe(Effect.map((values) => toConfig(method, values))),
  ),
);

const tokenFromEnvironment = getEnvRedacted(OP_SERVICE_ACCOUNT_TOKEN_ENV).pipe(
  Effect.map((token) =>
    token !== undefined && Redacted.value(token).length > 0
      ? { method: "service-account" as const, token }
      : undefined,
  ),
);

/** Desktop authorization prompts on the developer's machine, so CI can't use it. */
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

const readEnvironment = Effect.gen(function* () {
  const token = yield* tokenFromEnvironment;
  if (token !== undefined) return token;
  return yield* AuthError.make({
    message: "1Password requires OP_SERVICE_ACCOUNT_TOKEN in CI.",
  });
});

/**
 * 1Password profile authentication: a desktop account selector (1Password
 * manages the authorization) or a stored service account token.
 */
export const OnePasswordAuth = AuthProviderLayer<
  OnePasswordAuthConfig,
  OnePasswordResolvedCredentials
>()(PROVIDER_NAME, {
  configSchema: OnePasswordAuthConfigSchema,
  configure: () => configure,
  configureMethods: [
    { method: "desktop", fields: desktopFields },
    { method: "service-account", fields: serviceAccountFields },
  ],
  configureWith: (_, input) =>
    input.method === "desktop" || input.method === "service-account"
      ? validateFieldValues(PROVIDER_NAME, fieldsOf(input.method), input.values).pipe(
          Effect.map((values) => toConfig(input.method as OnePasswordAuthConfig["method"], values)),
        )
      : Effect.fail(
          AuthError.make({
            message:
              "1Password: use --method desktop --set account=<name-or-uuid>, or --method service-account --set token=-.",
          }),
        ),
  login: (_, config) =>
    collectFieldValues(fieldsOf(config.method)).pipe(
      Effect.map((values) => toConfig(config.method, values)),
    ),
  logout: () => Effect.void,
  read: (_, config) =>
    Effect.succeed(
      config.method === "desktop"
        ? { method: "desktop", account: config.account }
        : { method: "service-account", token: Redacted.make(config.token) },
    ),
  details: (_, config) =>
    Effect.succeed({
      lines:
        config.method === "desktop"
          ? [
              { key: "method", value: "desktop" },
              { key: "account", value: config.account },
            ]
          : [{ key: "method", value: "service-account" }],
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

/**
 * Resolve credentials independently of secrets loaded by earlier providers:
 * `OP_SERVICE_ACCOUNT_TOKEN` first, then an explicit desktop `account`, then
 * the selected profile.
 */
export const resolveCredentials = (account?: string) =>
  Effect.gen(function* () {
    const token = yield* tokenFromEnvironment;
    if (token !== undefined) return token;
    if (account !== undefined) {
      if (!account.trim())
        return yield* AuthError.make({
          message: "1Password: account must be a non-empty desktop account name or UUID.",
        });
      yield* requireLocal;
      return { method: "desktop" as const, account: account.trim() };
    }
    const resolved = yield* resolveProviderConfig<
      OnePasswordAuthConfig,
      OnePasswordResolvedCredentials
    >(PROVIDER_NAME).pipe(Effect.provide(OnePasswordAuth));
    const credentials = yield* resolved.resolve;
    if (credentials.method === "desktop") yield* requireLocal;
    return credentials;
  }).pipe(Effect.provide(CredentialsConfig));
