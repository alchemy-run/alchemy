import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { botUserId, listBotGuilds, ownership, physicalName } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

export interface ScheduledEventProps {
  /** Guild the event belongs to. Changing it replaces the event. */
  guildId: string;
  /**
   * Event name, 1-100 characters.
   * @default a name generated from the app, stage and logical id
   */
  name?: string;
  /** Description, up to 1000 characters. */
  description?: string;
  /**
   * Where the event happens: in a stage or voice channel (`channelId`), or
   * somewhere else (`location`).
   */
  type: "stage" | "voice" | "external";
  /** Stage or voice channel, for `stage` and `voice` events. */
  channelId?: string;
  /** Free-text location, for `external` events (1-100 characters). */
  location?: string;
  /** Start time, ISO 8601. Must be in the future when the event is created. */
  startTime: string;
  /** End time, ISO 8601. Required for `external` events. */
  endTime?: string;
  /** Cover image, as a data URI. Sent when it changes from the last deploy. */
  image?: string;
}

export interface ScheduledEventAttributes {
  /** Event id (a snowflake). */
  eventId: string;
  /** Guild id. */
  guildId: string;
  /** Event name. */
  name: string;
  /** Start time, ISO 8601. */
  startTime: string;
  /** End time, ISO 8601. */
  endTime: string | undefined;
  /** 1 scheduled, 2 active, 3 completed, 4 canceled. */
  status: number;
  /** Link that opens the event in Discord. */
  url: string;
}

/**
 * A scheduled event in a Discord guild: a stage, voice or external event
 * members can mark themselves interested in.
 *
 * The bot needs `MANAGE_EVENTS` (or `CREATE_EVENTS`). An event belongs to the
 * stack when the bot created it. Everything updates in place except the
 * guild. Discord rejects a start time in the past, so a stack that keeps an
 * event declared after it has ended should move `startTime` forward.
 *
 * ### Scheduling Events
 * **Example:** External meetup
 * ```typescript
 * yield* Discord.ScheduledEvent("Meetup", {
 *   guildId,
 *   name: "Community meetup",
 *   type: "external",
 *   location: "Somewhere Café, Berlin",
 *   startTime: "2027-03-01T18:00:00Z",
 *   endTime: "2027-03-01T21:00:00Z",
 * });
 * ```
 *
 * **Example:** Office hours on a stage
 * ```typescript
 * const stage = yield* Discord.Channel("Stage", { guildId, name: "Office Hours", type: "stage" });
 * yield* Discord.ScheduledEvent("OfficeHours", {
 *   guildId,
 *   name: "Office hours",
 *   type: "stage",
 *   channelId: stage.channelId,
 *   startTime: "2027-03-02T17:00:00Z",
 * });
 * ```
 *
 * @resource
 * @product Event
 */
export interface ScheduledEvent extends Resource<
  "Discord.ScheduledEvent",
  ScheduledEventProps,
  ScheduledEventAttributes,
  never,
  Providers
> {}

export const ScheduledEvent = Resource<ScheduledEvent>("Discord.ScheduledEvent");

const ENTITY_TYPES = { stage: 1, voice: 2, external: 3 } as const;

type Event = discord.GetGuildScheduledEventResponse;

const toAttributes = (event: Event): ScheduledEventAttributes => ({
  eventId: event.id,
  guildId: event.guild_id,
  name: event.name,
  startTime: event.scheduled_start_time,
  endTime: event.scheduled_end_time ?? undefined,
  status: Number(event.status),
  url: `https://discord.com/events/${event.guild_id}/${event.id}`,
});

const nameFor = (id: string, instanceId: string, props: { name?: string }) =>
  props.name !== undefined
    ? Effect.succeed(props.name)
    : physicalName(id, { instanceId, maxLength: 100 });

const getEvent = (guildId: string, eventId: string) =>
  discord
    .getGuildScheduledEvent({ guild_id: guildId, guild_scheduled_event_id: eventId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const sameInstant = (a: string | null | undefined, b: string | undefined) =>
  (a == null && b === undefined) ||
  (a != null && b !== undefined && new Date(a).getTime() === new Date(b).getTime());

const bodyOf = (name: string, news: ScheduledEventProps) => ({
  name,
  description: news.description ?? null,
  scheduled_start_time: news.startTime,
  scheduled_end_time: news.endTime ?? null,
  privacy_level: 2 as const,
  entity_type: ENTITY_TYPES[news.type],
  channel_id: news.type === "external" ? null : (news.channelId ?? null),
  entity_metadata: news.type === "external" ? { location: news.location ?? "" } : null,
});

export const ScheduledEventProvider = () =>
  Provider.succeed(ScheduledEvent, {
    stables: ["eventId", "guildId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || olds === undefined) return;
      if (news.guildId !== (output?.guildId ?? olds.guildId)) return { action: "replace" } as const;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      if (output !== undefined) {
        const event = yield* getEvent(output.guildId, output.eventId);
        return event ? toAttributes(event) : undefined;
      }
      if (olds?.guildId === undefined) return undefined;
      const name = yield* nameFor(id, instanceId, olds);
      const events = (yield* discord.listGuildScheduledEvents({ guild_id: olds.guildId })) ?? [];
      const match = events.find((e) => e.name === name);
      if (match === undefined) return undefined;
      return ownership(toAttributes(match), match.creator_id === (yield* botUserId()));
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
      const name =
        news.name === undefined && output?.name !== undefined
          ? output.name
          : yield* nameFor(id, instanceId, news);
      const body = bodyOf(name, news);
      const observed = output ? yield* getEvent(news.guildId, output.eventId) : undefined;
      if (observed === undefined) {
        return toAttributes(
          yield* discord.createGuildScheduledEvent({
            guild_id: news.guildId,
            body: { ...body, image: news.image } as discord.CreateGuildScheduledEventRequestBody,
          }),
        );
      }
      const location =
        "entity_metadata" in observed && observed.entity_metadata
          ? (observed.entity_metadata as { location?: string }).location
          : undefined;
      const unchanged =
        observed.name === name &&
        (observed.description ?? null) === body.description &&
        sameInstant(observed.scheduled_start_time, news.startTime) &&
        sameInstant(observed.scheduled_end_time, news.endTime) &&
        Number(observed.entity_type) === body.entity_type &&
        (observed.channel_id ?? null) === body.channel_id &&
        (news.type !== "external" || location === news.location) &&
        news.image === olds?.image;
      if (unchanged) return toAttributes(observed);
      return toAttributes(
        yield* discord.updateGuildScheduledEvent({
          guild_id: news.guildId,
          guild_scheduled_event_id: observed.id,
          body: {
            ...body,
            ...(news.image !== olds?.image ? { image: news.image ?? null } : {}),
          } as discord.UpdateGuildScheduledEventRequestBody,
        }),
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .deleteGuildScheduledEvent({
          guild_id: output.guildId,
          guild_scheduled_event_id: output.eventId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: Effect.fn(function* () {
      const botId = yield* botUserId();
      const guilds = yield* listBotGuilds();
      const rows = yield* Effect.forEach(
        guilds,
        (guild) =>
          discord.listGuildScheduledEvents({ guild_id: guild.id }).pipe(
            Effect.map((events) =>
              (events ?? []).filter((e) => e.creator_id === botId).map(toAttributes),
            ),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          ),
        { concurrency: 4 },
      );
      return rows.flat();
    }),
  });
