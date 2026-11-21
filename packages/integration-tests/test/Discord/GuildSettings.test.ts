import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

test.provider(
  "set guild settings and restore them on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;
      const guild = dc(discord.getGuild({ guild_id: guildId }));
      const before = yield* guild;
      const target = before.default_message_notifications === 1 ? 0 : 1;
      const afk = before.afk_timeout === 300 ? 900 : 300;

      yield* stack.deploy(
        Discord.GuildSettings("Settings", {
          guildId,
          defaultMessageNotifications: target,
          afkTimeout: afk,
        }),
      );
      const during = yield* guild;
      expect(during.default_message_notifications).toBe(target);
      expect(during.afk_timeout).toBe(afk);

      yield* stack.destroy();
      const after = yield* guild;
      expect(after.default_message_notifications).toBe(before.default_message_notifications);
      expect(after.afk_timeout).toBe(before.afk_timeout);
    }),
  { tags: tags("guild-settings"), timeout: 120_000, exclusive: "discord:guild-settings" },
);
