import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { AuditLogAction, ownedPerGuild } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

export interface StageInstanceProps {
  /** Stage channel to go live in. Changing it replaces the instance. */
  channelId: string;
  /** Topic shown on the stage, 1-120 characters. */
  topic: string;
  /** Scheduled event this stage instance starts. */
  scheduledEventId?: string;
  /** Notify @everyone that the stage started (needs `MENTION_EVERYONE`). @default false */
  sendStartNotification?: boolean;
}

export interface StageInstanceAttributes {
  /** Stage instance id. */
  stageInstanceId: string;
  /** Stage channel id. */
  channelId: string;
  /** Guild id. */
  guildId: string;
  /** Topic. */
  topic: string;
}

/**
 * A live stage: the stage channel is open with a topic until the instance is
 * deleted.
 *
 * The bot needs `MANAGE_CHANNELS`, `MUTE_MEMBERS` and `MOVE_MEMBERS` in the
 * stage channel, and stage channels need a Community guild. Destroying the
 * resource ends the stage. The topic updates in place.
 *
 * ### Opening a Stage
 * **Example:** Office hours
 * ```typescript
 * const stage = yield* Discord.Channel("Stage", {
 *   guildId,
 *   name: "Office Hours",
 *   type: "stage",
 * });
 * yield* Discord.StageInstance("Live", {
 *   channelId: stage.channelId,
 *   topic: "Ask us anything",
 * });
 * ```
 *
 * @resource
 * @product Channel
 */
export interface StageInstance extends Resource<
  "Discord.StageInstance",
  StageInstanceProps,
  StageInstanceAttributes,
  never,
  Providers
> {}

export const StageInstance = Resource<StageInstance>("Discord.StageInstance");

const toAttributes = (s: discord.StageInstanceResponse): StageInstanceAttributes => ({
  stageInstanceId: s.id,
  channelId: s.channel_id,
  guildId: s.guild_id,
  topic: s.topic,
});

const getStage = (channelId: string) =>
  discord
    .getStageInstance({ channel_id: channelId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const StageInstanceProvider = () =>
  Provider.succeed(StageInstance, {
    stables: ["channelId", "guildId"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return;
      if (news.channelId !== olds.channelId) return { action: "replace" } as const;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const channelId = output?.channelId ?? olds?.channelId;
      if (channelId === undefined) return undefined;
      const stage = yield* getStage(channelId);
      return stage ? toAttributes(stage) : undefined;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const observed = yield* getStage(news.channelId);
      if (observed === undefined) {
        return toAttributes(
          yield* discord.createStageInstance({
            channel_id: news.channelId,
            topic: news.topic,
            privacy_level: 2,
            guild_scheduled_event_id: news.scheduledEventId,
            send_start_notification: news.sendStartNotification,
          }),
        );
      }
      if (observed.topic === news.topic) return toAttributes(observed);
      return toAttributes(
        yield* discord.updateStageInstance({ channel_id: news.channelId, topic: news.topic }),
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .deleteStageInstance({ channel_id: output.channelId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: Effect.fn(function* () {
      const owned = yield* ownedPerGuild(AuditLogAction.StageInstanceCreate);
      const rows = yield* Effect.forEach(
        owned.filter(({ ids }) => ids.size > 0),
        ({ guildId }) =>
          discord.listGuildChannels({ guild_id: guildId }).pipe(
            Effect.flatMap((channels) =>
              Effect.forEach(
                (channels ?? []).filter((c) => Number(c.type) === 13),
                (c) => getStage(c.id),
              ),
            ),
            Effect.map((stages) =>
              stages
                .filter((s): s is discord.StageInstanceResponse => s !== undefined)
                .map(toAttributes),
            ),
          ),
        { concurrency: 4 },
      );
      return rows.flat().filter((s) => owned.some(({ ids }) => ids.has(s.stageInstanceId)));
    }),
  });
