import { credentials as slackCredentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/slack";
import * as Tooling from "@distilled.cloud/slack/tooling";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureField,
  type ConfigureMethod,
} from "alchemy/Auth/AuthProvider";
import { displayRedacted } from "alchemy/Auth/Credentials";
import { getEnv, getEnvRedacted } from "alchemy/Auth/Env";
import {
  collectFieldValues,
  storedSecret,
  storedValueText,
  validateFieldValues,
  type StoredValues,
} from "alchemy/Auth/StoredAuthProvider";
import * as Interaction from "alchemy/Interaction";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const SLACK_AUTH_PROVIDER_NAME = "Slack";

/**
 * Slack credentials as Alchemy resolves them.
 *
 * Slack authorizes each Web API family with a different token:
 *
 * - `botToken` (`xoxb-`) — the bot of an app installed in the workspace.
 *   Channels, bookmarks, canvases, user groups and every runtime binding
 *   call the API as this bot.
 * - `userToken` (`xoxp-`) — optional; methods Slack only allows on behalf
 *   of a person.
 * - `appConfig` — an app configuration token (`xoxe.xoxp-`) for the App
 *   Manifest API, which `Slack.App` uses. Configuration tokens expire after
 *   12 hours, so the profile keeps the refresh token and Alchemy rotates it
 *   (`tooling.tokens.rotate`) when the access token is missing or about to
 *   expire, saving the new pair back to the profile.
 */
export interface SlackResolvedCredentials {
  readonly botToken: Redacted.Redacted<string>;
  readonly userToken?: Redacted.Redacted<string>;
  readonly appConfig?: {
    readonly token: Redacted.Redacted<string>;
    /** Epoch milliseconds the configuration token expires at. */
    readonly expiresAt: number | undefined;
  };
  readonly apiBaseUrl: string;
  readonly source: { type: "stored" | "env"; details?: string };
}

/** Rotate the configuration token this long before it expires. */
const ROTATE_BEFORE_MS = 10 * 60 * 1000;

const fields: ReadonlyArray<ConfigureField> = [
  {
    name: "botToken",
    label: "Slack bot token (xoxb-…)",
    description:
      "From your app's OAuth & Permissions page, after installing it to the workspace Alchemy manages.",
    secret: true,
    validate: (value) =>
      value.startsWith("xoxb-") || value.startsWith("xoxe.xoxb-")
        ? undefined
        : "A bot token starts with xoxb- (or xoxe.xoxb- when token rotation is on).",
  },
  {
    name: "userToken",
    label: "Slack user token (xoxp-…, optional)",
    secret: true,
    optional: true,
  },
  {
    name: "appConfigRefreshToken",
    label: "App configuration refresh token (xoxe-…, optional, for Slack.App)",
    description:
      "From https://api.slack.com/apps → Your App Configuration Tokens → Generate Token. Alchemy rotates it and saves the new pair.",
    secret: true,
    optional: true,
  },
  {
    name: "appConfigToken",
    label: "App configuration access token (xoxe.xoxp-…, optional)",
    description: "Leave empty: Alchemy mints it from the refresh token.",
    secret: true,
    optional: true,
  },
  {
    name: "appConfigTokenExpiresAt",
    label: "App configuration token expiry (epoch ms, optional)",
    optional: true,
  },
  {
    name: "apiBaseUrl",
    label: "Slack Web API base URL (optional)",
    optional: true,
    placeholder: DEFAULT_API_BASE_URL,
  },
];

const fieldSchemas = Object.fromEntries(
  fields.map((field) => [
    field.name,
    field.optional ? Schema.optional(Schema.String) : Schema.String,
  ]),
);

export type SlackAuthConfig = {
  readonly method: "stored";
  readonly [key: string]: string | undefined;
};

const configSchema = Schema.Struct({
  method: Schema.Literal("stored"),
  ...fieldSchemas,
  // SAFETY: each property schema above is one entry of `fields`.
}) as unknown as Schema.Codec<SlackAuthConfig>;

const toConfig = (values: StoredValues): SlackAuthConfig => ({
  method: "stored",
  ...Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => {
      const text = storedValueText(value);
      return text === undefined || text === "" ? [] : [[key, text]];
    }),
  ),
});

const toResolved = (
  values: SlackAuthConfig,
  source: SlackResolvedCredentials["source"],
): SlackResolvedCredentials => {
  const appConfigToken = storedSecret(values.appConfigToken);
  const expiresAt = Number(values.appConfigTokenExpiresAt);
  return {
    botToken: storedSecret(values.botToken) ?? Redacted.make(""),
    ...(values.userToken ? { userToken: Redacted.make(values.userToken) } : {}),
    ...(appConfigToken
      ? {
          appConfig: {
            token: appConfigToken,
            expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
          },
        }
      : {}),
    apiBaseUrl: storedValueText(values.apiBaseUrl) ?? DEFAULT_API_BASE_URL,
    source,
  };
};

/**
 * Mint a fresh configuration token from the stored refresh token. The refresh
 * token is single-use, so the caller saves the returned pair before anything
 * else reads the profile (`read` runs under the profile credentials lock).
 */
const rotate = (config: SlackAuthConfig) =>
  Effect.gen(function* () {
    const refreshToken = config.appConfigRefreshToken;
    if (refreshToken === undefined) return config;
    const now = yield* Clock.currentTimeMillis;
    const expiresAt = Number(config.appConfigTokenExpiresAt);
    if (
      config.appConfigToken !== undefined &&
      Number.isFinite(expiresAt) &&
      expiresAt - now > ROTATE_BEFORE_MS
    ) {
      return config;
    }
    const rotated = yield* Tooling.rotateToken({ refresh_token: Redacted.make(refreshToken) }).pipe(
      // The tokenless form: rotation authenticates with the refresh token.
      Effect.provide(
        slackCredentials({
          token: Redacted.make(""),
          apiBaseUrl: config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
        }),
      ),
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError((cause) =>
        AuthError.make({
          message:
            cause._tag === "InvalidRefreshToken"
              ? "Slack: the app configuration refresh token was rejected (it is single-use and may have been rotated elsewhere). Generate a new one at https://api.slack.com/apps and run `alchemy profile edit --add Slack`."
              : `Slack: rotating the app configuration token failed: ${cause.message}`,
        }),
      ),
    );
    return {
      ...config,
      appConfigToken: Redacted.isRedacted(rotated.token)
        ? Redacted.value(rotated.token)
        : rotated.token,
      appConfigRefreshToken: Redacted.isRedacted(rotated.refresh_token)
        ? Redacted.value(rotated.refresh_token)
        : rotated.refresh_token,
      appConfigTokenExpiresAt: String(rotated.exp * 1000),
    } satisfies SlackAuthConfig;
  });

const readEnvironment = Effect.gen(function* () {
  const botToken =
    (yield* getEnvRedacted("SLACK_BOT_TOKEN")) ?? (yield* getEnvRedacted("SLACK_TOKEN"));
  if (!botToken) {
    return yield* AuthError.make({
      message: "Slack CI credentials not found. Set SLACK_BOT_TOKEN.",
    });
  }
  const userToken = yield* getEnvRedacted("SLACK_USER_TOKEN");
  const appConfigToken = yield* getEnvRedacted("SLACK_APP_CONFIG_TOKEN");
  return {
    botToken,
    ...(userToken ? { userToken } : {}),
    ...(appConfigToken ? { appConfig: { token: appConfigToken, expiresAt: undefined } } : {}),
    apiBaseUrl: (yield* getEnv("SLACK_API_URL")) ?? DEFAULT_API_BASE_URL,
    source: { type: "env" as const },
  } satisfies SlackResolvedCredentials;
});

const configureMethods: ReadonlyArray<ConfigureMethod> = [{ method: "stored", fields }];

/**
 * Layer that registers the Slack {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Included in the Slack
 * `providers()` layer so `alchemy profile edit --add Slack` can configure it.
 */
export const SlackAuth = AuthProviderLayer<SlackAuthConfig, SlackResolvedCredentials>()(
  SLACK_AUTH_PROVIDER_NAME,
  Effect.succeed({
    configSchema,
    configure: (_profileName: string) =>
      collectFieldValues(fields).pipe(
        Effect.map(toConfig),
        Effect.tap(() => Interaction.success("Slack: credentials saved.")),
      ),
    configureWith: (
      _profileName: string,
      input: { readonly method: string; readonly values: Record<string, string> },
    ) =>
      input.method === "stored"
        ? validateFieldValues(SLACK_AUTH_PROVIDER_NAME, fields, input.values).pipe(
            Effect.map(toConfig),
          )
        : Effect.fail(
            AuthError.make({
              message: `Slack: unknown method '${input.method}'. Valid methods: stored.`,
            }),
          ),
    configureMethods,
    login: (_profileName: string, config: SlackAuthConfig) => Effect.succeed(config),
    logout: () => Effect.void,
    details: (_profileName: string, config: SlackAuthConfig) =>
      Effect.succeed({
        lines: fields.flatMap((field) => {
          const value = config[field.name];
          if (value === undefined) return [];
          return [
            {
              key: field.name,
              value: field.secret ? displayRedacted(Redacted.make(value)) : value,
            },
          ];
        }),
      }),
    read: (
      _profileName: string,
      config: SlackAuthConfig,
      updateConfig?: (config: SlackAuthConfig) => Effect.Effect<void, AuthError>,
    ) =>
      Effect.gen(function* () {
        const current = yield* rotate(config);
        if (current !== config && updateConfig !== undefined) {
          yield* updateConfig(current);
        }
        return toResolved(current, { type: "stored" });
      }),
    readEnvironment,
    environment: [
      {
        name: "SLACK_BOT_TOKEN",
        required: true,
        secret: true,
        alternatives: ["SLACK_TOKEN"],
        description: "Bot token (xoxb-) of the app installed in the workspace.",
      },
      {
        name: "SLACK_USER_TOKEN",
        required: false,
        secret: true,
        description: "User token (xoxp-) for methods Slack only allows on behalf of a person.",
      },
      {
        name: "SLACK_APP_CONFIG_TOKEN",
        required: false,
        secret: true,
        description:
          "App configuration token (xoxe.xoxp-) for Slack.App. CI cannot rotate it, so mint a fresh one per run.",
      },
      {
        name: "SLACK_API_URL",
        required: false,
        description: "Web API base URL, for a proxy or mock.",
      },
    ],
  }),
);
