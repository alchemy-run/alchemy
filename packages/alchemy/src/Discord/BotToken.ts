import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { DiscordCredentials } from "./Credentials.ts";
import type * as Discord from "./Providers.ts";

export interface BotTokenProps {
  /**
   * The bot token to capture. Defaults to the provider's ambient
   * credential (`DISCORD_BOT_TOKEN`), so the common shape is
   * `Discord.BotToken("token")` with no props.
   */
  token?: Redacted.Redacted<string>;
}

/**
 * A Discord bot token as a resource — the Discord analogue of
 * `GitHub.PersonalAccessToken`, with the same honest limitation:
 * Discord has no API to MINT bot tokens (they live in the Developer
 * Portal), so this resource does not create one. It **captures** a
 * token — an explicit `token` prop, or by default the provider's
 * ambient credential — **validates** it against the API, and persists
 * it (encrypted) so hosts can bind it:
 *
 * - `value` is the token itself (`Redacted`) — the `Discord.*Http`
 *   binding layers yield it inside a host's init Effect, which binds
 *   it into the deployed Worker/Function's environment; the runtime
 *   client authenticates with it.
 * - `botUserId` / `username` record WHO the token is at the time it
 *   was captured — the deploy plan shows what the org is about to
 *   ship.
 *
 * Deleting the resource only forgets the token from state — resetting
 * a bot token happens in the Developer Portal and stays a human act.
 * @resource
 * @section Capturing a Token
 * @example The provider's credential (the common shape)
 * ```typescript
 * const token = yield* Discord.BotToken("factory-bot");
 * ```
 *
 * @example An explicit token
 * ```typescript
 * const token = yield* Discord.BotToken("bot", {
 *   token: Redacted.make(config.discordBotToken),
 * });
 * ```
 */
export interface BotToken extends Resource<
  "Discord.BotToken",
  BotTokenProps,
  {
    /** The token value — bind it into a host to authenticate at runtime. */
    value: Redacted.Redacted<string>;
    /** The bot user the token authenticates as. */
    botUserId: string;
    username: string;
  },
  never,
  Discord.Providers
> {}

export const BotToken = Resource<BotToken>("Discord.BotToken");

/** Validate a token and read the bot identity it authenticates as. */
const validate = Effect.fn(function* (token: Redacted.Redacted<string>) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.get("https://discord.com/api/v10/users/@me").pipe(
      HttpClientRequest.setHeaders({
        Authorization: `Bot ${Redacted.value(token)}`,
      }),
    ),
  );
  if (response.status !== 200) {
    return yield* Effect.fail(
      new Error(`Discord rejected the bot token (HTTP ${response.status})`),
    );
  }
  const user = (yield* response.json) as { id: string; username: string };
  return { botUserId: user.id, username: user.username };
});

export const BotTokenProvider = () =>
  Provider.succeed(BotToken, {
    stables: ["value", "botUserId"],
    // Non-listable: tokens are captured, never enumerated — Discord has
    // no API to list bot tokens, and there is no cloud-side object to
    // adopt.
    list: () => Effect.succeed([]),

    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      // The captured token is authoritative; a token reset out-of-band
      // reads as gone so the next deploy re-captures a working one.
      const probe = yield* validate(output.value).pipe(Effect.result);
      return Result.isSuccess(probe)
        ? { ...output, ...probe.success }
        : undefined;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // ONE flow: resolve the desired token (explicit prop, else the
      // provider's ambient credential), validate it, capture it.
      const token = news.token ?? (yield* yield* DiscordCredentials).token;
      const identity = yield* validate(token).pipe(Effect.orDie);
      return { value: token, ...identity };
    }),

    delete: Effect.fn(function* () {
      // Nothing to destroy: Discord exposes no API to reset a bot
      // token. Deleting the resource forgets the token from state only.
      yield* Effect.void;
    }),
  });
