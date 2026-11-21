import { DEFAULT_API_BASE_URL } from "@distilled.cloud/discord/Credentials";
import { AuthError } from "alchemy/Auth/AuthProvider";
import { getEnv, getEnvRedacted } from "alchemy/Auth/Env";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
} from "alchemy/Auth/StoredAuthProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export const DISCORD_AUTH_PROVIDER_NAME = "Discord";

export type DiscordAuthConfig = StoredAuthConfig;

/**
 * Resolved Discord credentials: the application's bot token and the API base
 * URL. Discord has no deploy-time identity besides the bot token, and the
 * application id is read from the token (`GET /applications/@me`).
 */
export interface DiscordResolvedCredentials {
  botToken: Redacted.Redacted<string>;
  apiBaseUrl: string;
  source: { type: DiscordAuthConfig["method"] | "env"; details?: string };
}

const readEnvironment = Effect.gen(function* () {
  const botToken =
    (yield* getEnvRedacted("DISCORD_BOT_TOKEN")) ?? (yield* getEnvRedacted("DISCORD_TOKEN"));
  if (!botToken) {
    return yield* AuthError.make({
      message: "Discord CI credentials not found. Set DISCORD_BOT_TOKEN or DISCORD_TOKEN.",
    });
  }
  return {
    botToken,
    apiBaseUrl: (yield* getEnv("DISCORD_API_URL")) ?? DEFAULT_API_BASE_URL,
    source: { type: "env" as const },
  } satisfies DiscordResolvedCredentials;
});

const discordAuth = makeStoredAuthProvider<DiscordResolvedCredentials>({
  provider: DISCORD_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "botToken",
      label: "Discord bot token (Developer Portal → your application → Bot → Reset Token)",
      secret: true,
    },
    {
      name: "apiBaseUrl",
      label: "Discord API base URL",
      optional: true,
      placeholder: DEFAULT_API_BASE_URL,
    },
  ],
  toResolved: (values, source) => ({
    botToken: storedSecret(values.botToken) ?? Redacted.make(""),
    apiBaseUrl: storedValueText(values.apiBaseUrl) ?? DEFAULT_API_BASE_URL,
    source: { type: source },
  }),
  readEnvironment,
  environment: [
    {
      name: "DISCORD_BOT_TOKEN",
      required: true,
      secret: true,
      alternatives: ["DISCORD_TOKEN"],
      description: "Bot token of the Discord application the stack manages.",
    },
    {
      name: "DISCORD_API_URL",
      required: false,
      description: "API base URL, for a proxy in front of https://discord.com/api/v10.",
    },
  ],
});

/**
 * Layer that registers the Discord {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Included in
 * `Discord.providers()` so `alchemy profile edit --add Discord` can configure
 * it.
 */
export const DiscordAuth = discordAuth.layer;

/** Schema of Discord's stored static-token values. */
export const DiscordStoredCredentials = discordAuth.storedSchema;
export type DiscordStoredCredentials = typeof DiscordStoredCredentials.Type;
