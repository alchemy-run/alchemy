import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { sameJson } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

/** A channel suggested on the welcome screen. */
export interface WelcomeChannel {
  /** Channel id. */
  channelId: string;
  /** Why to visit it, up to 42 characters. */
  description: string;
  /** Id of a guild emoji shown next to it. */
  emojiId?: string;
  /** Unicode emoji shown next to it. */
  emojiName?: string;
}

export interface WelcomeScreenProps {
  /** Community guild whose welcome screen is managed. */
  guildId: string;
  /** Whether new members see the welcome screen. @default true */
  enabled?: boolean;
  /** Server description shown on the screen, up to 140 characters. */
  description?: string;
  /** Up to 5 suggested channels. */
  channels?: WelcomeChannel[];
}

export interface WelcomeScreenAttributes {
  /** Guild id. */
  guildId: string;
  /** Description on the screen. */
  description: string | undefined;
  /** Suggested channel ids. */
  channelIds: string[];
  /** The welcome screen before the stack managed it; destroy restores it. */
  initial: {
    description: string | null;
    welcome_channels: Array<{
      channel_id: string;
      description: string;
      emoji_id: string | null;
      emoji_name: string | null;
    }>;
  };
}

/**
 * The welcome screen new members of a Community guild see: a description and
 * up to five suggested channels.
 *
 * The guild needs the `COMMUNITY` feature (see `GuildSettings`) and the bot
 * `MANAGE_GUILD`. The first deploy records the original screen and destroy
 * restores it.
 *
 * ### Welcoming Members
 * **Example:** Point new members at the rules and introductions
 * ```typescript
 * yield* Discord.WelcomeScreen("Welcome", {
 *   guildId,
 *   description: "The home of the Alchemy community",
 *   channels: [
 *     { channelId: rules.channelId, description: "Read the rules", emojiName: "📜" },
 *     { channelId: intros.channelId, description: "Say hi", emojiName: "👋" },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product Guild
 */
export interface WelcomeScreen extends Resource<
  "Discord.WelcomeScreen",
  WelcomeScreenProps,
  WelcomeScreenAttributes,
  never,
  Providers
> {}

export const WelcomeScreen = Resource<WelcomeScreen>("Discord.WelcomeScreen");

const wireChannels = (channels: WelcomeChannel[]) =>
  channels.map((c) => ({
    channel_id: c.channelId,
    description: c.description,
    emoji_id: c.emojiId ?? null,
    emoji_name: c.emojiName ?? null,
  }));

const toAttributes = (
  guildId: string,
  s: discord.GuildWelcomeScreenResponse,
  initial: WelcomeScreenAttributes["initial"],
): WelcomeScreenAttributes => ({
  guildId,
  description: s.description ?? undefined,
  channelIds: s.welcome_channels.map((c) => c.channel_id),
  initial,
});

const snapshot = (s: discord.GuildWelcomeScreenResponse): WelcomeScreenAttributes["initial"] => ({
  description: s.description,
  welcome_channels: s.welcome_channels.map((c) => ({
    channel_id: c.channel_id,
    description: c.description,
    emoji_id: c.emoji_id,
    emoji_name: c.emoji_name,
  })),
});

const getScreen = (guildId: string) =>
  discord
    .getGuildWelcomeScreen({ guild_id: guildId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const WelcomeScreenProvider = () =>
  Provider.succeed(WelcomeScreen, {
    nuke: { singleton: true },
    stables: ["guildId"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return;
      if (news.guildId !== olds.guildId) return { action: "replace" } as const;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const guildId = output?.guildId ?? olds?.guildId;
      if (guildId === undefined) return undefined;
      const s = yield* getScreen(guildId);
      return s ? toAttributes(guildId, s, output?.initial ?? snapshot(s)) : undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // A guild that never had a welcome screen answers 404 until one is set.
      const observed = yield* getScreen(news.guildId);
      const initial =
        output?.initial ??
        (observed ? snapshot(observed) : { description: null, welcome_channels: [] });
      const want = {
        description: news.description ?? null,
        welcome_channels: wireChannels(news.channels ?? []),
      };
      if (observed !== undefined && sameJson(snapshot(observed), want) && news.enabled !== false) {
        return toAttributes(news.guildId, observed, initial);
      }
      const updated = yield* discord.updateGuildWelcomeScreen({
        guild_id: news.guildId,
        enabled: news.enabled ?? true,
        ...want,
      });
      return toAttributes(news.guildId, updated, initial);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .updateGuildWelcomeScreen({
          guild_id: output.guildId,
          enabled: output.initial.welcome_channels.length > 0,
          ...output.initial,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: () => Effect.succeed([]),
  });
