import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

// A guild has at most one template; this test owns the test guild's slot.
test.provider(
  "create, rename and delete the guild template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;
      const templates = dc(discord.listGuildTemplates({ guild_id: guildId })).pipe(
        Effect.map((t) => t ?? []),
      );

      const v1 = yield* stack.deploy(Discord.GuildTemplate("Template", { guildId }));
      expect(v1.url).toBe(`https://discord.new/${v1.code}`);

      const v2 = yield* stack.deploy(
        Discord.GuildTemplate("Template", {
          guildId,
          name: "alchemy template",
          description: "made by alchemy",
        }),
      );
      expect(v2.code).toBe(v1.code);
      const observed = (yield* templates).find((t) => t.code === v1.code);
      expect(observed?.name).toBe("alchemy template");
      expect(observed?.description).toBe("made by alchemy");

      yield* stack.destroy();
      expect((yield* templates).some((t) => t.code === v1.code)).toBe(false);
    }),
  { tags: tags("guild-template"), timeout: 120_000, exclusive: "discord:guild-template" },
);
