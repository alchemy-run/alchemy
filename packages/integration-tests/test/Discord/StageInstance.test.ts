import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, expectGone, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

// Stage channels need a Community guild (see ChannelFollower.test.ts).
test.provider(
  "open a stage, change its topic and end it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;
      const deploy = (topic: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const stage = yield* Discord.Channel("Stage", {
              guildId,
              name: "alchemy-stage",
              type: "stage",
            });
            const live = yield* Discord.StageInstance("Live", {
              channelId: stage.channelId,
              topic,
            });
            return { stage, live };
          }),
        );
      const stageExists = (channelId: string) =>
        dc(discord.getStageInstance({ channel_id: channelId })).pipe(
          Effect.as(true),
          Effect.catchTag("NotFound", () => Effect.succeed(false)),
        );

      const v1 = yield* deploy("first topic");
      expect(v1.live.topic).toBe("first topic");
      const v2 = yield* deploy("second topic");
      expect(v2.live.stageInstanceId).toBe(v1.live.stageInstanceId);
      expect((yield* dc(discord.getStageInstance({ channel_id: v1.stage.channelId }))).topic).toBe(
        "second topic",
      );

      yield* stack.destroy();
      yield* expectGone(stageExists(v1.stage.channelId));
    }),
  { tags: tags("stage-instance"), timeout: 120_000 },
);
