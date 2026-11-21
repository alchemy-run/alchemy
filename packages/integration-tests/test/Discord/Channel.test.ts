import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, expectGone, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

const getChannel = (channelId: string) => dc(discord.getChannel({ channel_id: channelId }));

const channelExists = (channelId: string) =>
  getChannel(channelId).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create, update and replace a channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;

      // Create a category and a text channel under it with a generated name.
      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          const category = yield* Discord.Channel("Category", {
            guildId,
            type: "category",
          });
          const channel = yield* Discord.Channel("Text", {
            guildId,
            parentId: category.channelId,
            topic: "first topic",
          });
          return { category, channel };
        }),
      );
      expect(v1.channel.type).toBe("text");
      expect(v1.channel.parentId).toBe(v1.category.channelId);
      expect(v1.channel.name).toMatch(/^[a-z0-9_-]+$/);
      const observed1 = yield* getChannel(v1.channel.channelId);
      expect("topic" in observed1 && observed1.topic).toBe("first topic");

      // Update in place: topic, slowmode, nsfw, move out of the category.
      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          const category = yield* Discord.Channel("Category", {
            guildId,
            type: "category",
          });
          const channel = yield* Discord.Channel("Text", {
            guildId,
            topic: "second topic",
            rateLimitPerUser: 10,
            nsfw: true,
          });
          return { category, channel };
        }),
      );
      expect(v2.channel.channelId).toBe(v1.channel.channelId);
      expect(v2.channel.parentId).toBeUndefined();
      const observed2 = yield* getChannel(v1.channel.channelId);
      expect("topic" in observed2 && observed2.topic).toBe("second topic");
      expect("rate_limit_per_user" in observed2 && observed2.rate_limit_per_user).toBe(10);
      expect("nsfw" in observed2 && observed2.nsfw).toBe(true);

      // Unchanged redeploy plans no update.
      const plan = yield* stack.plan(
        Effect.gen(function* () {
          const category = yield* Discord.Channel("Category", {
            guildId,
            type: "category",
          });
          const channel = yield* Discord.Channel("Text", {
            guildId,
            topic: "second topic",
            rateLimitPerUser: 10,
            nsfw: true,
          });
          return { category, channel };
        }),
      );
      expect(Object.values(plan.resources).every((r) => r.action === "noop")).toBe(true);

      // Replace: text -> voice is a new channel.
      const v3 = yield* stack.deploy(
        Effect.gen(function* () {
          const category = yield* Discord.Channel("Category", {
            guildId,
            type: "category",
          });
          const channel = yield* Discord.Channel("Text", {
            guildId,
            type: "voice",
            userLimit: 5,
          });
          return { category, channel };
        }),
      );
      expect(v3.channel.channelId).not.toBe(v1.channel.channelId);
      expect(v3.channel.type).toBe("voice");
      yield* expectGone(channelExists(v1.channel.channelId));

      yield* stack.destroy();
      yield* expectGone(channelExists(v3.channel.channelId));
      yield* expectGone(channelExists(v1.category.channelId));
    }),
  { tags: tags("channel"), timeout: 120_000 },
);

test.provider(
  "channel permission overwrites are synced exactly",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;

      const deploy = (deny: string) =>
        stack.deploy(
          Discord.Channel("ReadOnly", {
            guildId,
            name: "alchemy-read-only",
            permissionOverwrites: [{ id: guildId, type: "role", deny }],
          }),
        );

      const channel = yield* deploy(Discord.Permissions.SendMessages);
      const observed1 = yield* getChannel(channel.channelId);
      const everyone1 = (
        "permission_overwrites" in observed1 ? (observed1.permission_overwrites ?? []) : []
      ).find((o) => o.id === guildId);
      expect(everyone1?.deny).toBe(Discord.Permissions.SendMessages);

      const both = Discord.combinePermissions(
        Discord.Permissions.SendMessages,
        Discord.Permissions.AddReactions,
      );
      yield* deploy(both);
      const observed2 = yield* getChannel(channel.channelId);
      const everyone2 = (
        "permission_overwrites" in observed2 ? (observed2.permission_overwrites ?? []) : []
      ).find((o) => o.id === guildId);
      expect(everyone2?.deny).toBe(both);

      yield* stack.destroy();
      yield* expectGone(channelExists(channel.channelId));
    }),
  { tags: tags("channel"), timeout: 120_000 },
);
