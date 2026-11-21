import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

// Needs a Community guild (see ChannelFollower.test.ts). Onboarding stays
// disabled so Discord's 7-default-channel minimum doesn't apply.
test.provider(
  "set onboarding prompts and restore them on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;
      const onboarding = dc(discord.getGuildsOnboarding({ guild_id: guildId }));
      const before = yield* onboarding;

      yield* stack.deploy(
        Effect.gen(function* () {
          const builders = yield* Discord.Role("Builders", { guildId, name: "alchemy-builders" });
          const general = yield* Discord.Channel("General", { guildId, name: "alchemy-onboard" });
          return yield* Discord.Onboarding("Onboarding", {
            guildId,
            enabled: false,
            defaultChannelIds: [general.channelId],
            prompts: [
              {
                title: "What brings you here?",
                options: [
                  { title: "Building", roleIds: [builders.roleId] },
                  { title: "Learning", channelIds: [general.channelId] },
                ],
              },
            ],
          });
        }),
      );
      const during = yield* onboarding;
      expect(during.prompts.map((p) => p.title)).toEqual(["What brings you here?"]);

      yield* stack.destroy();
      expect((yield* onboarding).prompts.length).toBe(before.prompts.length);
    }),
  { tags: tags("onboarding"), timeout: 120_000, exclusive: "discord:guild-settings" },
);
