import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials, type Config } from "@distilled.cloud/slack/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { SLACK_AUTH_PROVIDER_NAME, type SlackResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/slack/Credentials";

/**
 * The Slack credentials Alchemy resolved from the profile (or CI env), with
 * every token kind. Resources that need something other than the bot token
 * — `Slack.App` uses the app configuration token — read it here.
 */
export class SlackAuthCredentials extends Context.Service<
  SlackAuthCredentials,
  Effect.Effect<SlackResolvedCredentials, ConfigError>
>()("Slack.AuthCredentials") {}

/**
 * Credentials layers resolved through the Alchemy AuthProvider: the distilled
 * `Credentials` (the bot token every Slack operation defaults to) and
 * {@link SlackAuthCredentials} (all tokens). Resolution is deferred until the
 * first call and cached until the app configuration token is due to rotate.
 */
export const fromAuthProvider = () =>
  Layer.mergeAll(
    Layer.effect(
      SlackAuthCredentials,
      lazyCredentials<SlackResolvedCredentials, ConfigError>()(
        SLACK_AUTH_PROVIDER_NAME,
        (creds) => creds,
        { expiresAt: (creds) => creds.appConfig?.expiresAt },
      ),
    ),
    Layer.effect(
      Credentials,
      lazyCredentials<SlackResolvedCredentials, ConfigError>()(
        SLACK_AUTH_PROVIDER_NAME,
        (creds): Config => ({ token: creds.botToken, apiBaseUrl: creds.apiBaseUrl }),
        { expiresAt: (creds) => creds.appConfig?.expiresAt },
      ),
    ),
  );

/** A distilled `Credentials` config for one token. */
export const tokenConfig = (token: Redacted.Redacted<string>, apiBaseUrl: string): Config => ({
  token,
  apiBaseUrl,
});

/** The configuration token was not configured in the profile. */
export const missingAppConfigToken = () =>
  `Slack.App needs an app configuration token. Generate one at https://api.slack.com/apps (Your App Configuration Tokens) and run \`alchemy profile edit --add Slack\` to store its refresh token.`;

/**
 * Run a Slack operation as the app configuration token (the App Manifest
 * API). Fails with the distilled `ConfigError` when the profile has none.
 */
export const withAppConfigToken = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const resolve = yield* SlackAuthCredentials;
    const creds = yield* resolve;
    if (creds.appConfig === undefined) {
      return yield* new ConfigError({ message: missingAppConfigToken() });
    }
    return yield* effect.pipe(
      Effect.provideService(
        Credentials,
        Effect.succeed(tokenConfig(creds.appConfig.token, creds.apiBaseUrl)),
      ),
    );
  });

/** Redacted value or empty. */
export const reveal = (value: Redacted.Redacted<string> | string | undefined) =>
  value === undefined ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;
