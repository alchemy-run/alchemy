import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { PNG_32, pngDataUri } from "./fixtures.ts";
import { dc, tags } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

// Discord allows two username changes per hour; this test changes it twice
// (set, restore), so don't rerun it back to back.
test.provider(
  "set the bot's username and avatar, restore the username on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const me = dc(discord.getMyUser({}));
      const before = yield* me;

      const bot = yield* stack.deploy(
        Discord.Bot("Bot", { username: "alchemy-test-bot", avatar: pngDataUri(PNG_32) }),
      );
      expect(bot.userId).toBe(before.id);
      const during = yield* me;
      expect(during.username).toBe("alchemy-test-bot");
      expect(during.avatar).not.toBeNull();

      yield* stack.destroy();
      expect((yield* me).username).toBe(before.username);
    }),
  { tags: tags("bot"), timeout: 120_000, exclusive: "discord:application" },
);
