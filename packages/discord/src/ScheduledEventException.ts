import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "./Providers.ts";

export interface ScheduledEventExceptionProps {
  /** Guild of the event. */
  guildId: string;
  /** A recurring scheduled event. */
  eventId: string;
  /**
   * Start time of the occurrence to change, ISO 8601, as the recurrence rule
   * generates it. Changing it replaces the exception.
   */
  originalStartTime: string;
  /** Cancel this occurrence. @default false */
  canceled?: boolean;
  /** Move the occurrence to this start time, ISO 8601. */
  startTime?: string;
  /** Move the occurrence's end to this time, ISO 8601. */
  endTime?: string;
}

export interface ScheduledEventExceptionAttributes {
  /** Exception id. */
  exceptionId: string;
  /** Guild id. */
  guildId: string;
  /** Event id. */
  eventId: string;
  /** Whether the occurrence is canceled. */
  canceled: boolean;
}

/**
 * Changes one occurrence of a recurring scheduled event: cancels it or moves
 * it. Destroying the resource restores the occurrence.
 *
 * The bot needs `MANAGE_EVENTS`.
 *
 * ### Skipping an Occurrence
 * **Example:** Cancel the holiday standup
 * ```typescript
 * yield* Discord.ScheduledEventException("NoStandupNewYear", {
 *   guildId,
 *   eventId: standup.eventId,
 *   originalStartTime: "2027-01-01T09:00:00Z",
 *   canceled: true,
 * });
 * ```
 *
 * @resource
 * @product Event
 */
export interface ScheduledEventException extends Resource<
  "Discord.ScheduledEventException",
  ScheduledEventExceptionProps,
  ScheduledEventExceptionAttributes,
  never,
  Providers
> {}

export const ScheduledEventException = Resource<ScheduledEventException>(
  "Discord.ScheduledEventException",
);

const toAttributes = (
  guildId: string,
  e: discord.GuildScheduledEventExceptionResponse,
): ScheduledEventExceptionAttributes => ({
  exceptionId: e.event_exception_id,
  guildId,
  eventId: e.event_id,
  canceled: e.is_canceled,
});

export const ScheduledEventExceptionProvider = () =>
  Provider.succeed(ScheduledEventException, {
    stables: ["exceptionId", "guildId", "eventId"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return;
      if (
        news.guildId !== olds.guildId ||
        news.eventId !== olds.eventId ||
        new Date(news.originalStartTime).getTime() !== new Date(olds.originalStartTime).getTime()
      ) {
        return { action: "replace" } as const;
      }
    }),

    // Discord has no GET for an exception; the event existing is the best
    // evidence the exception still does.
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const event = yield* discord
        .getGuildScheduledEvent({
          guild_id: output.guildId,
          guild_scheduled_event_id: output.eventId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      return event ? output : undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const fields = {
        scheduled_start_time: news.startTime,
        scheduled_end_time: news.endTime,
        is_canceled: news.canceled ?? false,
      };
      if (output !== undefined) {
        const updated = yield* discord
          .updateGuildScheduledEventException({
            guild_id: news.guildId,
            guild_scheduled_event_id: news.eventId,
            exception_id: output.exceptionId,
            ...fields,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
        if (updated !== undefined) return toAttributes(news.guildId, updated);
      }
      return toAttributes(
        news.guildId,
        yield* discord.createGuildScheduledEventException({
          guild_id: news.guildId,
          guild_scheduled_event_id: news.eventId,
          original_scheduled_start_time: news.originalStartTime,
          ...fields,
        }),
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .deleteGuildScheduledEventException({
          guild_id: output.guildId,
          guild_scheduled_event_id: output.eventId,
          exception_id: output.exceptionId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    // Exceptions live on their event and go with it.
    list: () => Effect.succeed([]),
  });
