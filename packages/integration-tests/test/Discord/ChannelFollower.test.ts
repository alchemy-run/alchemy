import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, expectGone, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

const webhookExists = (webhookId: string) =>
  dc(discord.getWebhook({ webhook_id: webhookId })).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

// Announcement channels need the guild's COMMUNITY (or NEWS) feature: give
// the test guild Community once (Server Settings → Enable Community).
test.provider(
  "follow an announcement channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* Discord.Channel("Source", {
            guildId,
            name: "alchemy-releases",
            type: "announcement",
          });
          const target = yield* Discord.Channel("Target", { guildId, name: "alchemy-mirror" });
          const follower = yield* Discord.ChannelFollower("Follow", {
            sourceChannelId: source.channelId,
            targetChannelId: target.channelId,
          });
          return { source, target, follower };
        }),
      );
      const hook = yield* dc(discord.getWebhook({ webhook_id: out.follower.webhookId }));
      expect(hook.type).toBe(2);
      expect(hook.channel_id).toBe(out.target.channelId);

      yield* stack.destroy();
      yield* expectGone(webhookExists(out.follower.webhookId));
    }),
  { tags: tags("channel-follower"), timeout: 120_000 },
);
