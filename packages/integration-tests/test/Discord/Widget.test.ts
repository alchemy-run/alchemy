import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

test.provider(
  "enable the widget and restore it on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;
      const settings = dc(discord.getGuildWidgetSettings({ guild_id: guildId }));
      const before = yield* settings;

      const widget = yield* stack.deploy(
        Effect.gen(function* () {
          const channel = yield* Discord.Channel("Lobby", { guildId, name: "alchemy-widget" });
          return yield* Discord.Widget("Widget", {
            guildId,
            enabled: !before.enabled,
            channelId: channel.channelId,
          });
        }),
      );
      expect(widget.embedUrl).toBe(`https://discord.com/widget?id=${guildId}`);
      const during = yield* settings;
      expect(during.enabled).toBe(!before.enabled);
      expect(during.channel_id).toBe(widget.channelId);

      yield* stack.destroy();
      expect((yield* settings).enabled).toBe(before.enabled);
    }),
  { tags: tags("widget"), timeout: 120_000, exclusive: "discord:guild-settings" },
);
