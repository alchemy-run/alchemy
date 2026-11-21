import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { sameJson } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

export interface GuildSettingsProps {
  /** Guild whose settings are managed. Changing it replaces the resource. */
  guildId: string;
  /** Server name, 2-100 characters. */
  name?: string;
  /** Server description (Community guilds). */
  description?: string;
  /** Icon, as a data URI. Sent when it changes from the last deploy. */
  icon?: string;
  /** 0 none, 1 low (verified email), 2 medium (5 minutes), 3 high (10 minutes), 4 very high (phone). */
  verificationLevel?: 0 | 1 | 2 | 3 | 4;
  /** 0 all messages, 1 only mentions. */
  defaultMessageNotifications?: 0 | 1;
  /** 0 disabled, 1 members without roles, 2 all members. */
  explicitContentFilter?: 0 | 1 | 2;
  /** Voice channel idle members are moved to. */
  afkChannelId?: string;
  /** Seconds of idleness before moving to the AFK channel. */
  afkTimeout?: 60 | 300 | 900 | 1800 | 3600;
  /** Channel for join and boost messages. */
  systemChannelId?: string;
  /** Bit flags that suppress kinds of system messages. */
  systemChannelFlags?: number;
  /** Rules channel (Community guilds). */
  rulesChannelId?: string;
  /** Channel for Discord's community updates (Community guilds). */
  publicUpdatesChannelId?: string;
  /** Channel for safety alerts (Community guilds). */
  safetyAlertsChannelId?: string;
  /** Locale of a Community guild, e.g. `en-US`. */
  preferredLocale?: string;
  /** Show the boost progress bar. */
  premiumProgressBarEnabled?: boolean;
  /**
   * Guild features to turn on, of the ones a guild can toggle itself
   * (`COMMUNITY`, `DISCOVERABLE`, `INVITES_DISABLED`, `RAID_ALERTS_DISABLED`).
   * Other features the guild already has are kept.
   */
  features?: string[];
}

export interface GuildSettingsAttributes {
  /** Guild id. */
  guildId: string;
  /** Server name. */
  name: string;
  /** Features the guild has. */
  features: string[];
  /**
   * The values the managed settings had before the stack first set them.
   * Destroying the resource puts them back.
   */
  initial: Record<string, unknown>;
}

/**
 * The settings of a guild the bot is in: name, verification level, system
 * channels, Community features and the rest of `PATCH /guilds/{id}`.
 *
 * Bots can't create guilds, so this manages one that exists. The bot needs
 * `MANAGE_GUILD`. Only the settings you set are managed; the first deploy
 * records their original values and destroy restores them.
 *
 * ### Configuring a Guild
 * **Example:** Moderation defaults
 * ```typescript
 * yield* Discord.GuildSettings("Settings", {
 *   guildId,
 *   verificationLevel: 2,
 *   explicitContentFilter: 2,
 *   defaultMessageNotifications: 1,
 * });
 * ```
 *
 * **Example:** Turn the guild into a Community
 * ```typescript
 * const rules = yield* Discord.Channel("Rules", { guildId, name: "rules" });
 * const updates = yield* Discord.Channel("ModUpdates", { guildId, name: "mod-updates" });
 * yield* Discord.GuildSettings("Community", {
 *   guildId,
 *   features: ["COMMUNITY"],
 *   verificationLevel: 1,
 *   explicitContentFilter: 2,
 *   rulesChannelId: rules.channelId,
 *   publicUpdatesChannelId: updates.channelId,
 * });
 * ```
 *
 * @resource
 * @product Guild
 */
export interface GuildSettings extends Resource<
  "Discord.GuildSettings",
  GuildSettingsProps,
  GuildSettingsAttributes,
  never,
  Providers
> {}

export const GuildSettings = Resource<GuildSettings>("Discord.GuildSettings");

/** Props key → wire key on `PATCH /guilds/{id}` and the guild object. */
const FIELDS = {
  name: "name",
  description: "description",
  verificationLevel: "verification_level",
  defaultMessageNotifications: "default_message_notifications",
  explicitContentFilter: "explicit_content_filter",
  afkChannelId: "afk_channel_id",
  afkTimeout: "afk_timeout",
  systemChannelId: "system_channel_id",
  systemChannelFlags: "system_channel_flags",
  rulesChannelId: "rules_channel_id",
  publicUpdatesChannelId: "public_updates_channel_id",
  safetyAlertsChannelId: "safety_alerts_channel_id",
  preferredLocale: "preferred_locale",
  premiumProgressBarEnabled: "premium_progress_bar_enabled",
} as const satisfies Partial<Record<keyof GuildSettingsProps, string>>;

const TOGGLEABLE = ["COMMUNITY", "DISCOVERABLE", "INVITES_DISABLED", "RAID_ALERTS_DISABLED"];

type Guild = discord.GuildWithCountsResponse;

const observedValue = (guild: Guild, wire: string) =>
  (guild as unknown as Record<string, unknown>)[wire] ?? null;

/** Wire values the props set. */
const desired = (news: GuildSettingsProps) => {
  const body: Record<string, unknown> = {};
  for (const [prop, wire] of Object.entries(FIELDS)) {
    const value = news[prop as keyof GuildSettingsProps];
    if (value !== undefined) body[wire] = value;
  }
  return body;
};

const desiredFeatures = (guild: Guild, news: GuildSettingsProps) =>
  news.features === undefined
    ? undefined
    : [...new Set([...guild.features.filter((f) => !TOGGLEABLE.includes(f)), ...news.features])];

const toAttributes = (guild: Guild, initial: Record<string, unknown>): GuildSettingsAttributes => ({
  guildId: guild.id,
  name: guild.name,
  features: [...guild.features],
  initial,
});

const getGuild = (guildId: string) =>
  discord.getGuild({ guild_id: guildId }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const GuildSettingsProvider = () =>
  Provider.succeed(GuildSettings, {
    nuke: { singleton: true },
    stables: ["guildId"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return;
      if (news.guildId !== olds.guildId) return { action: "replace" } as const;
    }),

    // Settings always exist; nothing to own, so a cold read adopts.
    read: Effect.fn(function* ({ olds, output }) {
      const guildId = output?.guildId ?? olds?.guildId;
      if (guildId === undefined) return undefined;
      const guild = yield* getGuild(guildId);
      return guild ? toAttributes(guild, output?.initial ?? {}) : undefined;
    }),

    reconcile: Effect.fn(function* ({ news, olds, output }) {
      // Observe
      const guild = yield* discord.getGuild({ guild_id: news.guildId });

      // Capture the original value of every setting managed for the first time.
      const want = desired(news);
      const initial = { ...output?.initial };
      for (const wire of Object.keys(want)) {
        if (!(wire in initial)) initial[wire] = observedValue(guild, wire);
      }
      const features = desiredFeatures(guild, news);
      if (features !== undefined && !("features" in initial)) {
        initial.features = guild.features.filter((f) => TOGGLEABLE.includes(f));
      }

      // Sync the delta.
      const patch: Record<string, unknown> = {};
      for (const [wire, value] of Object.entries(want)) {
        if (!sameJson(observedValue(guild, wire), value)) patch[wire] = value;
      }
      if (features !== undefined && !sameJson([...guild.features].sort(), [...features].sort())) {
        patch.features = features;
      }
      if (news.icon !== undefined && news.icon !== olds?.icon) patch.icon = news.icon;
      if (Object.keys(patch).length === 0) return toAttributes(guild, initial);
      const updated = yield* discord.updateGuild({
        guild_id: news.guildId,
        ...(patch as Omit<discord.UpdateGuildRequest, "guild_id">),
      });
      return toAttributes({ ...guild, ...updated }, initial);
    }),

    // Restore what the stack changed.
    delete: Effect.fn(function* ({ output }) {
      const guild = yield* getGuild(output.guildId);
      if (guild === undefined || Object.keys(output.initial).length === 0) return;
      const { features: initialFeatures, ...rest } = output.initial;
      const patch: Record<string, unknown> = { ...rest };
      if (Array.isArray(initialFeatures)) {
        patch.features = [
          ...guild.features.filter((f) => !TOGGLEABLE.includes(f)),
          ...(initialFeatures as string[]),
        ];
      }
      yield* discord
        .updateGuild({
          guild_id: output.guildId,
          ...(patch as Omit<discord.UpdateGuildRequest, "guild_id">),
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: () => Effect.succeed([]),
  });
