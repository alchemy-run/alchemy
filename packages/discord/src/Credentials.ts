import type { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/discord/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { DISCORD_AUTH_PROVIDER_NAME, type DiscordResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/discord/Credentials";

/**
 * Build a `Credentials` layer from a literal bot token. Useful in scripts and
 * tests that already hold the token.
 */
export const fromBotToken = (
  token: string | Redacted.Redacted<string>,
  options?: { readonly apiBaseUrl?: string },
) =>
  Layer.succeed(
    Credentials,
    Effect.succeed({
      token: typeof token === "string" ? Redacted.make(token) : token,
      tokenType: "Bot" as const,
      apiBaseUrl: options?.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    }),
  );

/**
 * Build a `Credentials` layer that resolves the bot token through the Alchemy
 * AuthProvider for the current profile (`alchemy profile edit --add Discord`),
 * falling back to `DISCORD_BOT_TOKEN` in CI.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    lazyCredentials<DiscordResolvedCredentials, ConfigError>()(
      DISCORD_AUTH_PROVIDER_NAME,
      (creds) => ({
        token: creds.botToken,
        tokenType: "Bot" as const,
        apiBaseUrl: creds.apiBaseUrl,
      }),
    ),
  );
