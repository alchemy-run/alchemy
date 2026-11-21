import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { botUserId, listBotGuilds } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

export interface ChannelFollowerProps {
  /** Announcement channel to follow (any guild the bot can see). */
  sourceChannelId: string;
  /** Channel in a guild the bot manages that receives the crossposts. */
  targetChannelId: string;
}

export interface ChannelFollowerAttributes {
  /** Id of the follower webhook Discord created in the target channel. */
  webhookId: string;
  /** Followed announcement channel. */
  sourceChannelId: string;
  /** Channel receiving the crossposts. */
  targetChannelId: string;
}

/**
 * Follows an announcement channel: every message published (crossposted)
 * there is copied into the target channel.
 *
 * Discord models a follow as a webhook of type "Channel Follower" in the
 * target channel, so the bot needs `MANAGE_WEBHOOKS` there. Destroying the
 * resource deletes that webhook. Changing either channel replaces it.
 *
 * ### Following Announcements
 * **Example:** Mirror release notes into another server
 * ```typescript
 * const releases = yield* Discord.Channel("Releases", {
 *   guildId: hubGuildId,
 *   name: "releases",
 *   type: "announcement",
 * });
 * const mirror = yield* Discord.Channel("ReleasesMirror", {
 *   guildId: communityGuildId,
 *   name: "releases",
 * });
 * yield* Discord.ChannelFollower("FollowReleases", {
 *   sourceChannelId: releases.channelId,
 *   targetChannelId: mirror.channelId,
 * });
 * ```
 *
 * @resource
 * @product Channel
 */
export interface ChannelFollower extends Resource<
  "Discord.ChannelFollower",
  ChannelFollowerProps,
  ChannelFollowerAttributes,
  never,
  Providers
> {}

export const ChannelFollower = Resource<ChannelFollower>("Discord.ChannelFollower");

/** The follower webhook for `source` in `target`, if one exists. */
const findFollower = (sourceChannelId: string, targetChannelId: string) =>
  discord.listChannelWebhooks({ channel_id: targetChannelId }).pipe(
    Effect.map((hooks) =>
      (hooks ?? []).find(
        (h) => h.type === 2 && "source_channel" in h && h.source_channel?.id === sourceChannelId,
      ),
    ),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const ChannelFollowerProvider = () =>
  Provider.succeed(ChannelFollower, {
    stables: ["webhookId", "sourceChannelId", "targetChannelId"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return;
      if (
        news.sourceChannelId !== olds.sourceChannelId ||
        news.targetChannelId !== olds.targetChannelId
      ) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const props = output ?? olds;
      if (props?.targetChannelId === undefined) return undefined;
      const hook = yield* findFollower(props.sourceChannelId, props.targetChannelId);
      return hook
        ? {
            webhookId: hook.id,
            sourceChannelId: props.sourceChannelId,
            targetChannelId: props.targetChannelId,
          }
        : undefined;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // Observe → ensure. Following twice is idempotent on Discord's side too.
      const existing = yield* findFollower(news.sourceChannelId, news.targetChannelId);
      const webhookId =
        existing?.id ??
        (yield* discord.followChannel({
          channel_id: news.sourceChannelId,
          webhook_channel_id: news.targetChannelId,
        })).webhook_id;
      return {
        webhookId,
        sourceChannelId: news.sourceChannelId,
        targetChannelId: news.targetChannelId,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .deleteWebhook({ webhook_id: output.webhookId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: Effect.fn(function* () {
      const botId = yield* botUserId();
      const guilds = yield* listBotGuilds();
      const rows = yield* Effect.forEach(
        guilds,
        (guild) =>
          discord.getGuildWebhooks({ guild_id: guild.id }).pipe(
            Effect.map((hooks) =>
              (hooks ?? []).flatMap((h) =>
                h.type === 2 &&
                "source_channel" in h &&
                h.source_channel?.id !== undefined &&
                h.channel_id !== null &&
                h.user?.id === botId
                  ? [
                      {
                        webhookId: h.id,
                        sourceChannelId: h.source_channel.id,
                        targetChannelId: h.channel_id,
                      },
                    ]
                  : [],
              ),
            ),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          ),
        { concurrency: 4 },
      );
      return rows.flat();
    }),
  });
