import { AuthError, AuthProviderLayer, type ConfigureField } from "alchemy/Auth/AuthProvider";
import { getEnvRedacted, mapPromptCancellation } from "alchemy/Auth/Env";
import { ProfileStore } from "alchemy/Auth/Profile";
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

/** Personal access token used for unattended access (`pst_<token>::<key>`). */
export const PROTON_PASS_PERSONAL_ACCESS_TOKEN_ENV = "PROTON_PASS_PERSONAL_ACCESS_TOKEN";

const PROVIDER_NAME = "ProtonPass";

/**
 * A stored Proton Pass profile entry: use the Proton Pass CLI's own login
 * (`pass-cli login`), or a personal access token.
 */
export const ProtonPassAuthConfigSchema = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("cli-session"),
  }),
  Schema.Struct({
    method: Schema.Literal("personal-access-token"),
    token: Schema.NonEmptyString,
  }),
]);
export type ProtonPassAuthConfig = typeof ProtonPassAuthConfigSchema.Type;

export type ProtonPassResolvedCredentials =
  | { readonly method: "cli-session" }
  | { readonly method: "personal-access-token"; readonly token: Redacted.Redacted<string> };

const tokenFields: ReadonlyArray<ConfigureField> = [
  {
    name: "token",
    label: "Proton Pass personal access token",
    description:
      "Create one with `pass-cli personal-access-token create`, then grant it viewer access to the vaults you load.",
    secret: true,
    validate: (value) =>
      /^pst_[^:]+::.+$/.test(value.trim()) ? undefined : "Expected pst_<token>::<key>.",
  },
];

const fieldsOf = (method: ProtonPassAuthConfig["method"]) =>
  method === "personal-access-token" ? tokenFields : [];

const toConfig = (
  method: ProtonPassAuthConfig["method"],
  values: Record<string, string | Redacted.Redacted<string> | undefined>,
): ProtonPassAuthConfig =>
  method === "cli-session" ? { method } : { method, token: storedValueText(values.token)!.trim() };

const configure = Interaction.select({
  message: "Proton Pass authentication method",
  options: [
    {
      value: "cli-session" as const,
      label: "Proton Pass CLI login",
      description: "Read with the session from `pass-cli login`",
    },
    {
      value: "personal-access-token" as const,
      label: "Personal access token",
      description: "Store a personal access token in this profile",
    },
  ],
}).pipe(
  mapPromptCancellation,
  Effect.flatMap((method) =>
    collectFieldValues(fieldsOf(method)).pipe(Effect.map((values) => toConfig(method, values))),
  ),
);

const tokenFromEnvironment = getEnvRedacted(PROTON_PASS_PERSONAL_ACCESS_TOKEN_ENV).pipe(
  Effect.map((token) =>
    token !== undefined && Redacted.value(token).trim().length > 0
      ? {
          method: "personal-access-token" as const,
          token: Redacted.make(Redacted.value(token).trim()),
        }
      : undefined,
  ),
);

const readEnvironment = Effect.gen(function* () {
  const token = yield* tokenFromEnvironment;
  if (token !== undefined) return token;
  return yield* AuthError.make({
    message: `Proton Pass requires ${PROTON_PASS_PERSONAL_ACCESS_TOKEN_ENV} in CI.`,
  });
});

/**
 * Proton Pass profile authentication: the Proton Pass CLI's own login, or a
 * stored personal access token.
 */
export const ProtonPassAuth = AuthProviderLayer<
  ProtonPassAuthConfig,
  ProtonPassResolvedCredentials
>()(PROVIDER_NAME, {
  configSchema: ProtonPassAuthConfigSchema,
  configure: () => configure,
  configureMethods: [
    { method: "cli-session", fields: [] },
    { method: "personal-access-token", fields: tokenFields },
  ],
  configureWith: (_, input) =>
    input.method === "cli-session" || input.method === "personal-access-token"
      ? validateFieldValues(PROVIDER_NAME, fieldsOf(input.method), input.values).pipe(
          Effect.map((values) => toConfig(input.method as ProtonPassAuthConfig["method"], values)),
        )
      : Effect.fail(
          AuthError.make({
            message:
              "ProtonPass: use --method cli-session, or --method personal-access-token --set token=-.",
          }),
        ),
  login: (_, config) =>
    collectFieldValues(fieldsOf(config.method)).pipe(
      Effect.map((values) => toConfig(config.method, values)),
    ),
  logout: () => Effect.void,
  read: (_, config) =>
    Effect.succeed(
      config.method === "cli-session"
        ? { method: "cli-session" }
        : { method: "personal-access-token", token: Redacted.make(config.token) },
    ),
  details: (_, config) => Effect.succeed({ lines: [{ key: "method", value: config.method }] }),
  readEnvironment,
  environment: [
    {
      name: PROTON_PASS_PERSONAL_ACCESS_TOKEN_ENV,
      required: true,
      secret: true,
      description: "Personal access token for unattended access",
    },
  ],
});

/** Whether the selected profile has a Proton Pass entry. Profiles don't exist in CI. */
const profileConfigured = Effect.gen(function* () {
  const ci = yield* Config.Boolean("CI").pipe(Config.withDefault(false));
  if (ci) return false;
  const store = yield* ProfileStore;
  const { name } = yield* store.current;
  const profile = yield* store.getProfile(name);
  return profile?.providers[PROVIDER_NAME] !== undefined;
}).pipe(
  Effect.mapError((cause) =>
    AuthError.make({ message: "Proton Pass: could not read the selected profile.", cause }),
  ),
);

/**
 * Resolve credentials independently of secrets loaded by earlier providers:
 * `PROTON_PASS_PERSONAL_ACCESS_TOKEN` first, then the selected profile's
 * ProtonPass entry, then the Proton Pass CLI's own session.
 */
export const resolveCredentials = Effect.gen(function* () {
  const token = yield* tokenFromEnvironment;
  if (token !== undefined) return token;
  if (yield* profileConfigured) {
    const resolved = yield* resolveProviderConfig<
      ProtonPassAuthConfig,
      ProtonPassResolvedCredentials
    >(PROVIDER_NAME).pipe(Effect.provide(ProtonPassAuth));
    return yield* resolved.resolve;
  }
  return { method: "cli-session" as const };
}).pipe(Effect.provide(CredentialsConfig));
