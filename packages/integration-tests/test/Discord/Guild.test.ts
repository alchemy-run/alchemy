import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

test.provider(
  "reference a guild by id and by name; destroy leaves it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;
      const byId = yield* stack.deploy(Discord.Guild("Community", { guildId }));
      expect(byId.guildId).toBe(guildId);
      expect(byId.everyoneRoleId).toBe(guildId);

      const byName = yield* stack.deploy(Discord.Guild("Community", { name: byId.name }));
      expect(byName.guildId).toBe(guildId);

      yield* stack.destroy();
      expect((yield* dc(discord.getGuild({ guild_id: guildId }))).id).toBe(guildId);
    }),
  { tags: tags("guild"), timeout: 60_000 },
);

test.provider(
  "a guild the bot isn't in fails with GuildNotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(Discord.Guild("Missing", { name: "alchemy-no-such-guild" }))
        .pipe(Effect.flip);
      expect(JSON.stringify(error)).toContain("Discord.GuildNotFound");
      yield* stack.destroy();
    }),
  { tags: tags("guild"), timeout: 60_000 },
);
