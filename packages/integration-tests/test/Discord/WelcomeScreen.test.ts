import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

// Needs a Community guild (see ChannelFollower.test.ts).
test.provider(
  "set the welcome screen and restore it on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;
      const screen = dc(discord.getGuildWelcomeScreen({ guild_id: guildId })).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
      const before = yield* screen;

      yield* stack.deploy(
        Effect.gen(function* () {
          const rules = yield* Discord.Channel("Rules", { guildId, name: "alchemy-welcome" });
          return yield* Discord.WelcomeScreen("Welcome", {
            guildId,
            description: "alchemy welcome",
            channels: [{ channelId: rules.channelId, description: "Start here", emojiName: "👋" }],
          });
        }),
      );
      const during = yield* screen;
      expect(during?.description).toBe("alchemy welcome");
      expect(during?.welcome_channels[0]?.description).toBe("Start here");

      yield* stack.destroy();
      expect((yield* screen)?.description ?? null).toBe(before?.description ?? null);
    }),
  { tags: tags("welcome-screen"), timeout: 120_000, exclusive: "discord:guild-settings" },
);
