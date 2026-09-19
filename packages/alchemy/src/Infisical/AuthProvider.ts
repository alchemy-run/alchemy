import {
  anonymous,
  DEFAULT_API_BASE_URL,
  loginWithUniversalAuth,
} from "@distilled.cloud/infisical";
import * as Retry from "@distilled.cloud/infisical/Retry";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureField,
} from "../Auth/AuthProvider.ts";
import { displayRedacted } from "../Auth/Credentials.ts";
import { getEnv, getEnvRedacted, mapPromptCancellation } from "../Auth/Env.ts";
import {
  collectFieldValues,
  storedValueText,
  validateFieldValues,
  type StoredValues,
} from "../Auth/StoredAuthProvider.ts";
import * as Interaction from "../Interaction.ts";

export const INFISICAL_TOKEN_ENV = "INFISICAL_TOKEN";
/** Same name the Infisical CLI uses for self-hosted instances. */
export const INFISICAL_API_URL_ENV = "INFISICAL_API_URL";

const PROVIDER_NAME = "Infisical";
const API_TIMEOUT = Duration.seconds(30);

/**
 * A machine identity's client id + secret. The secret never expires unless
 * given a TTL in Infisical, and Alchemy exchanges it for a short-lived
 * access token on every read, so this is the method for local development.
 */
const UniversalAuthConfig = Schema.Struct({
  method: Schema.Literal("universal-auth"),
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.NonEmptyString,
  apiBaseUrl: Schema.optional(Schema.String),
});

/** A ready-made access token, e.g. from `infisical login --plain`. Expires. */
const AccessTokenConfig = Schema.Struct({
  method: Schema.Literal("access-token"),
  token: Schema.NonEmptyString,
  apiBaseUrl: Schema.optional(Schema.String),
});

export const InfisicalAuthConfigSchema = Schema.Union([
  UniversalAuthConfig,
  AccessTokenConfig,
]);
export type InfisicalAuthConfig = typeof InfisicalAuthConfigSchema.Type;

export interface InfisicalResolvedCredentials {
  readonly token: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
}

const apiBaseUrlField: ConfigureField = {
  name: "apiBaseUrl",
  label: "Infisical API URL",
  description: "Only for self-hosted instances.",
  placeholder: DEFAULT_API_BASE_URL,
  optional: true,
};

const universalAuthFields: ReadonlyArray<ConfigureField> = [
  {
    name: "clientId",
    label: "Machine identity client ID",
    description:
      "From the machine identity's Universal Auth settings in Infisical.",
  },
  {
    name: "clientSecret",
    label: "Machine identity client secret",
    secret: true,
  },
  apiBaseUrlField,
];

const accessTokenFields: ReadonlyArray<ConfigureField> = [
  {
    name: "token",
    label: "Infisical access token",
    description: "A machine identity or user access token. Expires.",
    secret: true,
  },
  apiBaseUrlField,
];

const rejectedCredentials = (cause: unknown) =>
  new AuthError({
    message:
      "Infisical rejected the machine identity credentials. Check the client ID and secret, and that the secret has not expired or hit its use limit.",
    cause,
  });

/**
 * Exchange a machine identity's client credentials for an access token.
 * Infisical answers 401 when either half is wrong or the secret is spent.
 */
export const mintAccessToken = (config: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly apiBaseUrl?: string;
}): Effect.Effect<
  InfisicalResolvedCredentials,
  AuthError,
  HttpClient.HttpClient
> =>
  loginWithUniversalAuth({
    clientId: config.clientId,
    clientSecret: Redacted.make(config.clientSecret),
  }).pipe(
    Retry.none,
    Effect.provide(anonymous({ apiBaseUrl: config.apiBaseUrl })),
    Effect.timeout(API_TIMEOUT),
    Effect.map((response) => ({
      token: Redacted.isRedacted(response.accessToken)
        ? response.accessToken
        : Redacted.make(response.accessToken),
      apiBaseUrl: config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    })),
    Effect.mapError(rejectedCredentials),
  );

/** Resolve the token a stored configuration grants. */
const resolve = (
  config: InfisicalAuthConfig,
): Effect.Effect<
  InfisicalResolvedCredentials,
  AuthError,
  HttpClient.HttpClient
> =>
  config.method === "universal-auth"
    ? mintAccessToken(config)
    : Effect.succeed({
        token: Redacted.make(config.token),
        apiBaseUrl: config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
      });

/**
 * Turn collected field values into a stored configuration. Universal-auth
 * credentials are verified with a real login first so a typo fails now
 * rather than on the next deploy.
 */
const toConfig = (
  method: InfisicalAuthConfig["method"],
  values: StoredValues,
): Effect.Effect<InfisicalAuthConfig, AuthError, HttpClient.HttpClient> => {
  const apiBaseUrl = storedValueText(values.apiBaseUrl);
  if (method === "access-token") {
    return Effect.succeed({
      method,
      token: storedValueText(values.token)!,
      apiBaseUrl,
    });
  }
  const config: InfisicalAuthConfig = {
    method,
    clientId: storedValueText(values.clientId)!,
    clientSecret: storedValueText(values.clientSecret)!,
    apiBaseUrl,
  };
  return mintAccessToken(config).pipe(Effect.as(config));
};

const fieldsFor = (method: InfisicalAuthConfig["method"]) =>
  method === "universal-auth" ? universalAuthFields : accessTokenFields;

const chooseMethod = Interaction.accessors.prompt
  .select({
    message: "Infisical authentication method",
    options: [
      {
        value: "universal-auth" as const,
        label: "Machine identity",
        description: "Client ID and secret; never expires",
      },
      {
        value: "access-token" as const,
        label: "Access token",
        description: "Paste an existing token; expires",
      },
    ],
  })
  .pipe(mapPromptCancellation);

const readEnvironment = Effect.gen(function* () {
  const token = yield* getEnvRedacted(INFISICAL_TOKEN_ENV);
  if (token === undefined || Redacted.value(token).length === 0) {
    return yield* new AuthError({
      message: `Infisical credentials are missing. Set ${INFISICAL_TOKEN_ENV} in CI, or run \`alchemy profile edit --add Infisical\` locally.`,
    });
  }
  const apiBaseUrl = yield* getEnv(INFISICAL_API_URL_ENV);
  return { token, apiBaseUrl: apiBaseUrl ?? DEFAULT_API_BASE_URL };
});

/**
 * Infisical profile authentication: a machine identity's universal-auth
 * credentials (recommended) or a pasted access token.
 */
export const InfisicalAuth = AuthProviderLayer<
  InfisicalAuthConfig,
  InfisicalResolvedCredentials
>()(PROVIDER_NAME, {
  configSchema: InfisicalAuthConfigSchema,
  configure: () =>
    chooseMethod.pipe(
      Effect.flatMap((method) =>
        collectFieldValues(fieldsFor(method)).pipe(
          Effect.flatMap((values) => toConfig(method, values)),
        ),
      ),
    ),
  configureMethods: [
    { method: "universal-auth", fields: universalAuthFields },
    { method: "access-token", fields: accessTokenFields },
  ],
  configureWith: (_, input) => {
    if (input.method !== "universal-auth" && input.method !== "access-token") {
      return Effect.fail(
        new AuthError({
          message: `Infisical: unknown method '${input.method}'. Valid methods: universal-auth, access-token.`,
        }),
      );
    }
    const method = input.method;
    return validateFieldValues(
      PROVIDER_NAME,
      fieldsFor(method),
      input.values,
    ).pipe(Effect.flatMap((values) => toConfig(method, values)));
  },
  // Nothing to re-authenticate: stored credentials are long-lived (or, for
  // access tokens, replaced by reconfiguring). Verifying them is enough.
  login: (_, config) => resolve(config).pipe(Effect.as(config)),
  // Client secrets are revoked from the Infisical dashboard by an admin;
  // there is nothing session-like to tear down.
  logout: () => Effect.void,
  read: (_, config) => resolve(config),
  details: (_, config) =>
    Effect.succeed({
      lines: [
        { key: "method", value: config.method },
        config.method === "universal-auth"
          ? { key: "clientId", value: config.clientId }
          : {
              key: "token",
              value: displayRedacted(Redacted.make(config.token)),
            },
        { key: "apiBaseUrl", value: config.apiBaseUrl ?? DEFAULT_API_BASE_URL },
      ],
    }),
  readEnvironment,
  environment: [
    {
      name: INFISICAL_TOKEN_ENV,
      required: true,
      secret: true,
      description: "Machine identity access token (e.g. minted via OIDC in CI)",
    },
    {
      name: INFISICAL_API_URL_ENV,
      required: false,
      description: "Base URL of a self-hosted Infisical instance",
    },
  ],
});
