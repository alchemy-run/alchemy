import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AuthError } from "../Auth/AuthProvider.ts";

export interface DiscordCredentialsService {
  /** The bot token (sent as `Authorization: Bot <token>`). */
  readonly token: Redacted.Redacted<string>;
}

export class DiscordCredentials extends Context.Service<
  DiscordCredentials,
  Effect.Effect<DiscordCredentialsService>
>()("Discord::Credentials") {}

/**
 * Build a `DiscordCredentials` layer from a literal bot token. Useful
 * for tests or when callers already have the token in hand.
 */
export const fromBotToken = (token: string | Redacted.Redacted<string>) =>
  Layer.succeed(
    DiscordCredentials,
    Effect.succeed({
      token: typeof token === "string" ? Redacted.make(token) : token,
    }),
  );

/**
 * Build a `DiscordCredentials` layer that reads the bot token from
 * `DISCORD_BOT_TOKEN` at layer build time.
 */
export const fromEnv = () =>
  Layer.succeed(
    DiscordCredentials,
    Effect.gen(function* () {
      const token = yield* Config.redacted("DISCORD_BOT_TOKEN").pipe(
        Config.option,
      );
      if (token._tag === "None") {
        return yield* new AuthError({
          message: "Discord credentials not found. Set DISCORD_BOT_TOKEN.",
        });
      }
      return { token: token.value };
    }).pipe(Effect.orDie),
  );
