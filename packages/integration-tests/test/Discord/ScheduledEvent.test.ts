import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, expectGone, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

// Fixed far-future times keep the props deterministic across runs.
const start = "2030-01-01T18:00:00.000Z";
const end = "2030-01-01T21:00:00.000Z";

test.provider(
  "create and update an external scheduled event",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;
      const get = (eventId: string) =>
        dc(
          discord.getGuildScheduledEvent({ guild_id: guildId, guild_scheduled_event_id: eventId }),
        );
      const exists = (eventId: string) =>
        get(eventId).pipe(
          Effect.as(true),
          Effect.catchTag("NotFound", () => Effect.succeed(false)),
        );

      const v1 = yield* stack.deploy(
        Discord.ScheduledEvent("Meetup", {
          guildId,
          type: "external",
          location: "Berlin",
          startTime: start,
          endTime: end,
        }),
      );
      expect(v1.status).toBe(1);

      const v2 = yield* stack.deploy(
        Discord.ScheduledEvent("Meetup", {
          guildId,
          name: "alchemy meetup",
          description: "updated",
          type: "external",
          location: "Lisbon",
          startTime: start,
          endTime: end,
        }),
      );
      expect(v2.eventId).toBe(v1.eventId);
      const observed = yield* get(v1.eventId);
      expect(observed.name).toBe("alchemy meetup");
      expect(observed.description).toBe("updated");
      expect(
        (observed as { entity_metadata?: { location?: string } }).entity_metadata?.location,
      ).toBe("Lisbon");

      yield* stack.destroy();
      yield* expectGone(exists(v1.eventId));
    }),
  { tags: tags("scheduled-event"), timeout: 120_000 },
);
