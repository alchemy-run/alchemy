import * as discord from "@distilled.cloud/discord/discord";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "./Providers.ts";

export interface BotProps {
  /**
   * Bot username, 2-32 characters, without "discord" or "clyde". Discord
   * allows two username changes per hour.
   */
  username?: string;
  /** Avatar, as a data URI. Sent when it changes from the last deploy. */
  avatar?: string;
  /** Profile banner, as a data URI. Sent when it changes from the last deploy. */
  banner?: string;
}

export interface BotAttributes {
  /** The bot user's id. */
  userId: string;
  /** Current username. */
  username: string;
  /** Avatar hash, if set. */
  avatarHash: string | undefined;
  /** `<@userId>`, the mention syntax for the bot. */
  mention: string;
  /** The username before the stack managed it; destroy restores it. */
  initialUsername: string;
}

/**
 * The profile of the application's bot user: username, avatar and banner.
 *
 * There is one bot per application. The first deploy records the original
 * username and destroy restores it. Discord limits username changes to two
 * per hour, so don't redeploy username changes in a loop.
 *
 * ### Configuring the Bot
 * **Example:** Name and avatar
 * ```typescript
 * const fs = yield* FileSystem.FileSystem;
 * const png = yield* fs.readFile("./assets/bot.png");
 * const bot = yield* Discord.Bot("Bot", {
 *   username: "deploy-bot",
 *   avatar: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
 * });
 * ```
 *
 * @resource
 * @product Application
 */
export interface Bot extends Resource<"Discord.Bot", BotProps, BotAttributes, never, Providers> {}

export const Bot = Resource<Bot>("Discord.Bot");

const toAttributes = (user: discord.UserPIIResponse, initialUsername: string): BotAttributes => ({
  userId: user.id,
  username: user.username,
  avatarHash: user.avatar ?? undefined,
  mention: `<@${user.id}>`,
  initialUsername,
});

export const BotProvider = () =>
  Provider.succeed(Bot, {
    nuke: { singleton: true },
    stables: ["userId"],

    read: Effect.fn(function* ({ output }) {
      const user = yield* discord.getMyUser({});
      return toAttributes(user, output?.initialUsername ?? user.username);
    }),

    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const user = yield* discord.getMyUser({});
      const initialUsername = output?.initialUsername ?? user.username;
      const username = news.username ?? user.username;
      const avatar = news.avatar !== undefined && news.avatar !== olds?.avatar;
      const banner = news.banner !== undefined && news.banner !== olds?.banner;
      if (username === user.username && !avatar && !banner) {
        return toAttributes(user, initialUsername);
      }
      const updated = yield* discord.updateMyUser({
        username,
        ...(avatar ? { avatar: news.avatar } : {}),
        ...(banner ? { banner: news.banner } : {}),
      });
      return toAttributes(updated, initialUsername);
    }),

    delete: Effect.fn(function* ({ output }) {
      const user = yield* discord.getMyUser({});
      if (user.username !== output.initialUsername) {
        yield* discord.updateMyUser({ username: output.initialUsername });
      }
    }),

    list: () => Effect.succeed([]),
  });
