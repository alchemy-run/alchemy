import * as Auth from "@distilled.cloud/slack/auth";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { Credentials, tokenConfig } from "./Credentials.ts";
import type { Providers } from "./Providers.ts";

export interface BotTokenProps {
  /**
   * The bot token (`xoxb-…`) to capture. Defaults to the bot token of the
   * Slack profile, the same bot that creates the stack's channels.
   */
  token?: Redacted.Redacted<string>;
}

export interface BotTokenAttributes {
  /** The token. Yield it inside a host to bind it into the host's environment. */
  value: Redacted.Redacted<string>;
  /** Web API base URL the token authenticates against. */
  apiBaseUrl: string;
  /** Workspace the bot belongs to. */
  teamId: string;
  /** The bot's user ID (`U…`), the author of the messages it posts. */
  botUserId: string;
  /** The bot ID (`B…`). */
  botId: string;
  /** The app the bot belongs to. */
  appId: string;
}

export type BotToken = Resource<
  "Slack.BotToken",
  BotTokenProps,
  BotTokenAttributes,
  never,
  Providers
>;

/**
 * A Slack bot token captured as a resource, so a Worker or Function can call
 * the Web API at runtime.
 *
 * Slack has no API to mint a token: a bot token exists only once a person
 * installs the app to the workspace through OAuth, and it carries the app's
 * scopes, not a narrower set. So this resource creates nothing. It captures a
 * token (the `token` prop, or the profile's bot token by default), checks it
 * with `auth.test`, and keeps it in state. The `Slack.*Http` binding layers
 * capture one per host and bind its `value` into the host as a secret.
 * Deleting the resource only forgets the token.
 *
 * ### Capturing a Token
 * **Example:** The profile's bot token
 * ```typescript
 * const bot = yield* Slack.BotToken("Bot");
 * ```
 *
 * **Example:** Another app's bot token from config
 * ```typescript
 * const bot = yield* Slack.BotToken("Bot", {
 *   token: yield* Config.redacted("SUPPORT_BOT_TOKEN"),
 * });
 * ```
 *
 * @resource
 * @product Bot
 */
export const BotToken = Resource<BotToken>("Slack.BotToken");

const identify = (token: Redacted.Redacted<string>, apiBaseUrl: string) =>
  Auth.testAuth({}).pipe(
    Effect.map((identity) => ({
      teamId: identity.team_id ?? "",
      botUserId: identity.user_id ?? "",
      botId: identity.bot_id ?? "",
      appId: identity.app_id ?? "",
    })),
    Effect.provideService(Credentials, Effect.succeed(tokenConfig(token, apiBaseUrl))),
  );

export const BotTokenProvider = () =>
  Provider.succeed(BotToken, {
    stables: ["value", "apiBaseUrl", "teamId", "botUserId", "botId", "appId"],
    // Slack cannot enumerate tokens.
    list: () => Effect.succeed([]),
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      // A revoked token reads as gone, so the next deploy captures a working one.
      const probe = yield* identify(output.value, output.apiBaseUrl).pipe(Effect.result);
      return Result.isSuccess(probe) ? { ...output, ...probe.success } : undefined;
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const credentials = yield* yield* Credentials;
      const value = news?.token ?? credentials.token;
      const identity = yield* identify(value, credentials.apiBaseUrl);
      return { value, apiBaseUrl: credentials.apiBaseUrl, ...identity };
    }),
    delete: () => Effect.void,
  });
