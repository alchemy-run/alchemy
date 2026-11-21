import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  AuditLogAction,
  isCreatedByBot,
  ownedPerGuild,
  ownership,
  physicalName,
  sameJson,
} from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

/** Channel kinds a guild can hold. */
export type ChannelType =
  | "text"
  | "voice"
  | "category"
  | "announcement"
  | "stage"
  | "forum"
  | "media";

const CHANNEL_TYPES: Record<ChannelType, number> = {
  text: 0,
  voice: 2,
  category: 4,
  announcement: 5,
  stage: 13,
  forum: 15,
  media: 16,
};

const channelTypeName = (type: number): ChannelType =>
  (Object.entries(CHANNEL_TYPES).find(([, value]) => value === type)?.[0] as ChannelType) ?? "text";

/** A role or member permission overwrite on a channel. */
export interface ChannelPermissionOverwrite {
  /** Role id (the guild id is the `@everyone` role) or user id. */
  id: string;
  /** Whether `id` is a role or a member. */
  type: "role" | "member";
  /** Permission bits explicitly allowed, as a decimal string or number. */
  allow?: string | number;
  /** Permission bits explicitly denied, as a decimal string or number. */
  deny?: string | number;
}

/** A tag that can be applied to posts in a forum or media channel. */
export interface ForumTag {
  /** Tag name, 0-20 characters. */
  name: string;
  /** Only members with `MANAGE_THREADS` can add or remove the tag. */
  moderated?: boolean;
  /** Id of a guild's custom emoji. */
  emojiId?: string;
  /** Unicode emoji character. */
  emojiName?: string;
}

export interface ChannelProps {
  /** Guild the channel belongs to. Changing it replaces the channel. */
  guildId: string;
  /**
   * Channel name, 1-100 characters. Text-like channels are lowercased by
   * Discord with spaces turned into dashes.
   * @default a name generated from the app, stage and logical id
   */
  name?: string;
  /**
   * Channel kind. Changing it replaces the channel, except between `text`
   * and `announcement` (Discord converts those in place; the guild must have
   * the `NEWS` feature).
   * @default "text"
   */
  type?: ChannelType;
  /** Category (a `category` channel) to nest the channel under. */
  parentId?: string;
  /** Sort position among siblings. */
  position?: number;
  /** Channel topic, 0-1024 characters (0-4096 for forum and media). */
  topic?: string;
  /** Whether the channel is age-restricted. @default false */
  nsfw?: boolean;
  /** Slowmode, in seconds between messages per user (0-21600). @default 0 */
  rateLimitPerUser?: number;
  /** Voice and stage bitrate, in bits per second (8000 or higher). */
  bitrate?: number;
  /** Voice and stage user limit (0 = unlimited). */
  userLimit?: number;
  /** Voice region id; `null`/omitted means automatic. */
  rtcRegion?: string;
  /** Default auto-archive minutes for new threads (60, 1440, 4320, 10080). */
  defaultAutoArchiveDuration?: 60 | 1440 | 4320 | 10080;
  /** Slowmode applied to newly created threads, in seconds. */
  defaultThreadRateLimitPerUser?: number;
  /** Tags available to posts in a forum or media channel. */
  availableTags?: ForumTag[];
  /**
   * Permission overwrites. When set, the channel's overwrites are exactly
   * this list; when omitted, overwrites are left alone (manage them with
   * {@link PermissionOverwrite} instead). Don't use both on one channel.
   */
  permissionOverwrites?: ChannelPermissionOverwrite[];
}

export interface ChannelAttributes {
  /** Channel id (a snowflake). */
  channelId: string;
  /** Guild the channel belongs to. */
  guildId: string;
  /** Channel name as Discord stored it. */
  name: string;
  /** Channel kind. */
  type: ChannelType;
  /** Parent category id. */
  parentId: string | undefined;
  /** Sort position. */
  position: number;
  /** Channel topic. */
  topic: string | undefined;
  /** Whether the channel is age-restricted. */
  nsfw: boolean;
  /** Slowmode, in seconds. */
  rateLimitPerUser: number;
  /** Link that opens the channel in the Discord client. */
  url: string;
}

/**
 * A channel in a Discord guild: a text, voice, category, announcement, stage,
 * forum or media channel.
 *
 * The bot needs `MANAGE_CHANNELS` in the guild (and `MANAGE_ROLES` to set
 * permission overwrites). Discord has no tags, so a channel belongs to the
 * stack when its bot created it, according to the guild's audit log; a
 * channel found by name that another user created is reported as foreign and
 * needs `--adopt`.
 *
 * ### Creating Channels
 * **Example:** Text channel
 * ```typescript
 * const general = yield* Discord.Channel("General", {
 *   guildId,
 *   name: "general",
 *   topic: "Talk about anything",
 * });
 * ```
 *
 * **Example:** Category with a voice channel
 * ```typescript
 * const lounge = yield* Discord.Channel("Lounge", {
 *   guildId,
 *   name: "Lounge",
 *   type: "category",
 * });
 * yield* Discord.Channel("Voice", {
 *   guildId,
 *   name: "Hangout",
 *   type: "voice",
 *   parentId: lounge.channelId,
 *   userLimit: 10,
 * });
 * ```
 *
 * **Example:** Forum with tags
 * ```typescript
 * yield* Discord.Channel("Support", {
 *   guildId,
 *   name: "support",
 *   type: "forum",
 *   availableTags: [{ name: "bug" }, { name: "question", emojiName: "❓" }],
 * });
 * ```
 *
 * ### Permissions
 * **Example:** Read-only announcements channel
 * ```typescript
 * yield* Discord.Channel("Announcements", {
 *   guildId,
 *   name: "announcements",
 *   permissionOverwrites: [
 *     // the @everyone role's id is the guild id
 *     { id: guildId, type: "role", deny: Discord.Permissions.SendMessages },
 *   ],
 * });
 * ```
 *
 * ### Replacement
 * Changing `guildId`, or `type` other than between `text` and
 * `announcement`, creates a new channel and deletes the old one, with its
 * message history.
 *
 * @resource
 * @product Channel
 */
export interface Channel extends Resource<
  "Discord.Channel",
  ChannelProps,
  ChannelAttributes,
  never,
  Providers
> {}

export const Channel = Resource<Channel>("Discord.Channel");

const isConvertible = (a: ChannelType, b: ChannelType) =>
  (a === "text" || a === "announcement") && (b === "text" || b === "announcement");

const overwriteType = (type: "role" | "member") => (type === "role" ? 0 : 1);

const desiredOverwrites = (overwrites: ChannelPermissionOverwrite[]) =>
  overwrites.map((o) => ({
    id: o.id,
    type: overwriteType(o.type),
    allow: String(o.allow ?? 0),
    deny: String(o.deny ?? 0),
  }));

const observedOverwrites = (channel: discord.GuildChannelResponse) =>
  (channel.permission_overwrites ?? []).map((o) => ({
    id: o.id,
    type: Number(o.type),
    allow: o.allow,
    deny: o.deny,
  }));

const sortById = <T extends { id: string }>(items: T[]) =>
  [...items].sort((a, b) => (a.id < b.id ? -1 : 1));

const desiredTags = (tags: ForumTag[]) =>
  tags.map((tag) => ({
    name: tag.name,
    moderated: tag.moderated ?? false,
    emoji_id: tag.emojiId ?? null,
    emoji_name: tag.emojiName ?? null,
  }));

const observedTags = (channel: discord.GuildChannelResponse) =>
  (channel.available_tags ?? []).map((tag) => ({
    name: tag.name,
    moderated: tag.moderated,
    emoji_id: tag.emoji_id ?? null,
    emoji_name: tag.emoji_name ?? null,
  }));

const isGuildChannel = (channel: unknown): channel is discord.GuildChannelResponse =>
  typeof channel === "object" &&
  channel !== null &&
  "guild_id" in channel &&
  "position" in channel &&
  !("thread_metadata" in channel);

const toAttributes = (channel: discord.GuildChannelResponse): ChannelAttributes => ({
  channelId: channel.id,
  guildId: channel.guild_id,
  name: channel.name,
  type: channelTypeName(Number(channel.type)),
  parentId: channel.parent_id ?? undefined,
  position: channel.position,
  topic: channel.topic ?? undefined,
  nsfw: channel.nsfw ?? false,
  rateLimitPerUser: channel.rate_limit_per_user ?? 0,
  url: `https://discord.com/channels/${channel.guild_id}/${channel.id}`,
});

const getChannel = (channelId: string) =>
  discord.getChannel({ channel_id: channelId }).pipe(
    Effect.map((channel) => (isGuildChannel(channel) ? channel : undefined)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const nameFor = Effect.fn(function* (
  id: string,
  instanceId: string,
  props: { name?: string; type?: ChannelType },
) {
  if (props.name !== undefined) return props.name;
  const textLike = !["voice", "category", "stage"].includes(props.type ?? "text");
  return yield* physicalName(id, {
    instanceId,
    maxLength: 100,
    lowercase: textLike,
    charset: textLike ? /[^a-z0-9_-]/g : undefined,
  });
});

/** Fields of `news` that differ from `observed`, as an update body. */
const delta = (news: ChannelProps, name: string, observed: discord.GuildChannelResponse) => {
  const body: discord.UpdateGuildChannelRequestPartial = {};
  const type = news.type ?? "text";
  if (observed.name !== name) body.name = name;
  if (channelTypeName(Number(observed.type)) !== type) body.type = CHANNEL_TYPES[type];
  if ((observed.parent_id ?? undefined) !== news.parentId && news.parentId !== undefined) {
    body.parent_id = news.parentId;
  } else if (news.parentId === undefined && observed.parent_id) {
    body.parent_id = null;
  }
  if (news.position !== undefined && observed.position !== news.position) {
    body.position = news.position;
  }
  if (
    (observed.topic ?? undefined) !== news.topic &&
    !(news.topic === undefined && !observed.topic)
  ) {
    body.topic = news.topic ?? null;
  }
  if ((observed.nsfw ?? false) !== (news.nsfw ?? false)) body.nsfw = news.nsfw ?? false;
  if (
    news.rateLimitPerUser !== undefined &&
    (observed.rate_limit_per_user ?? 0) !== news.rateLimitPerUser
  ) {
    body.rate_limit_per_user = news.rateLimitPerUser;
  }
  if (news.bitrate !== undefined && observed.bitrate !== news.bitrate) {
    body.bitrate = news.bitrate;
  }
  if (news.userLimit !== undefined && observed.user_limit !== news.userLimit) {
    body.user_limit = news.userLimit;
  }
  if (news.rtcRegion !== undefined && (observed.rtc_region ?? undefined) !== news.rtcRegion) {
    body.rtc_region = news.rtcRegion;
  }
  if (
    news.defaultAutoArchiveDuration !== undefined &&
    observed.default_auto_archive_duration !== news.defaultAutoArchiveDuration
  ) {
    body.default_auto_archive_duration = news.defaultAutoArchiveDuration;
  }
  if (
    news.defaultThreadRateLimitPerUser !== undefined &&
    observed.default_thread_rate_limit_per_user !== news.defaultThreadRateLimitPerUser
  ) {
    body.default_thread_rate_limit_per_user = news.defaultThreadRateLimitPerUser;
  }
  if (
    news.availableTags !== undefined &&
    !sameJson(observedTags(observed), desiredTags(news.availableTags))
  ) {
    body.available_tags = desiredTags(news.availableTags);
  }
  if (
    news.permissionOverwrites !== undefined &&
    !sameJson(
      sortById(observedOverwrites(observed)),
      sortById(desiredOverwrites(news.permissionOverwrites)),
    )
  ) {
    body.permission_overwrites = desiredOverwrites(news.permissionOverwrites).map((o) => ({
      ...o,
      allow: Number(o.allow),
      deny: Number(o.deny),
    }));
  }
  return body;
};

export const ChannelProvider = () =>
  Provider.succeed(Channel, {
    stables: ["channelId", "guildId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return;
      const guildId = output?.guildId ?? olds?.guildId;
      if (guildId !== undefined && news.guildId !== guildId) return { action: "replace" } as const;
      const oldType = output?.type ?? olds?.type ?? "text";
      const newType = news.type ?? "text";
      if (oldType !== newType && !isConvertible(oldType, newType)) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      if (output !== undefined) {
        const channel = yield* getChannel(output.channelId);
        return channel ? toAttributes(channel) : undefined;
      }
      if (olds?.guildId === undefined) return undefined;
      // Cold read (state lost after a create): find the channel by name and
      // claim it only if this bot created it.
      const name = yield* nameFor(id, instanceId, olds);
      const channels = (yield* discord.listGuildChannels({ guild_id: olds.guildId })) ?? [];
      const match = channels.filter(isGuildChannel).find((c) => c.name === name);
      if (match === undefined) return undefined;
      const owned = yield* isCreatedByBot(olds.guildId, AuditLogAction.ChannelCreate, match.id);
      return ownership(toAttributes(match), owned);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const name =
        output?.name !== undefined && news.name === undefined
          ? output.name
          : yield* nameFor(id, instanceId, news);

      // Observe
      let channel = output ? yield* getChannel(output.channelId) : undefined;

      // Ensure
      if (channel === undefined) {
        const created = yield* discord.createGuildChannel({
          guild_id: news.guildId,
          name,
          type: CHANNEL_TYPES[news.type ?? "text"],
          parent_id: news.parentId,
          position: news.position,
          topic: news.topic,
          nsfw: news.nsfw,
          rate_limit_per_user: news.rateLimitPerUser,
          bitrate: news.bitrate,
          user_limit: news.userLimit,
          rtc_region: news.rtcRegion,
          default_auto_archive_duration: news.defaultAutoArchiveDuration,
          default_thread_rate_limit_per_user: news.defaultThreadRateLimitPerUser,
          available_tags: news.availableTags ? desiredTags(news.availableTags) : undefined,
          permission_overwrites: news.permissionOverwrites
            ? desiredOverwrites(news.permissionOverwrites).map((o) => ({
                ...o,
                allow: Number(o.allow),
                deny: Number(o.deny),
              }))
            : undefined,
        });
        return toAttributes(created);
      }

      // Sync — patch only the fields that drifted from the observed channel.
      const body = delta(news, name, channel);
      if (Object.keys(body).length === 0) return toAttributes(channel);
      const updated = yield* discord.updateChannel({ channel_id: channel.id, body });
      if (isGuildChannel(updated)) channel = updated;
      return toAttributes(channel);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .deleteChannel({ channel_id: output.channelId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: Effect.fn(function* () {
      const owned = yield* ownedPerGuild(AuditLogAction.ChannelCreate);
      const rows = yield* Effect.forEach(
        owned.filter(({ ids }) => ids.size > 0),
        ({ guildId, ids }) =>
          discord.listGuildChannels({ guild_id: guildId }).pipe(
            Effect.map((channels) =>
              (channels ?? [])
                .filter(isGuildChannel)
                .filter((c) => ids.has(c.id))
                .map(toAttributes),
            ),
          ),
        { concurrency: 4 },
      );
      return rows.flat();
    }),
  });
