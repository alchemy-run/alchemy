import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

/**
 * Recurring events are created through the API with `recurrence_rule`; the
 * resource takes a plain event id, so the test makes a weekly event
 * out-of-band (deterministically named) and deletes it afterwards.
 */
test.provider(
  "cancel one occurrence of a recurring event",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;
      const name = `alchemy-recurring-${stack.stage}`;
      const existing = (yield* dc(discord.listGuildScheduledEvents({ guild_id: guildId }))) ?? [];
      for (const e of existing.filter((e) => e.name === name)) {
        yield* dc(
          discord.deleteGuildScheduledEvent({ guild_id: guildId, guild_scheduled_event_id: e.id }),
        );
      }
      const first = "2030-01-07T17:00:00.000Z";
      const event = yield* dc(
        discord.createGuildScheduledEvent({
          guild_id: guildId,
          body: {
            name,
            scheduled_start_time: first,
            scheduled_end_time: "2030-01-07T18:00:00.000Z",
            privacy_level: 2,
            entity_type: 3,
            entity_metadata: { location: "online" },
            recurrence_rule: { start: first, frequency: 2, interval: 1, by_weekday: [0] },
          } as discord.CreateGuildScheduledEventRequestBody,
        }),
      );

      const exception = yield* stack.deploy(
        Discord.ScheduledEventException("SkipNextWeek", {
          guildId,
          eventId: event.id,
          originalStartTime: "2030-01-14T17:00:00.000Z",
          canceled: true,
        }),
      );
      expect(exception.canceled).toBe(true);
      expect(exception.eventId).toBe(event.id);

      yield* stack.destroy();
      yield* dc(
        discord.deleteGuildScheduledEvent({
          guild_id: guildId,
          guild_scheduled_event_id: event.id,
        }),
      );
    }),
  { tags: tags("scheduled-event-exception"), timeout: 120_000 },
);
