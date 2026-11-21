import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, tags, testBotUserId, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

const botRoles = (guildId: string, userId: string) =>
  dc(discord.getGuildMember({ guild_id: guildId, user_id: userId })).pipe(
    Effect.map((m) => m.roles),
  );

// The only member a bot can always assign a role to is itself.
test.provider(
  "assign, move and remove a role on the bot member",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;
      const userId = yield* testBotUserId;

      const deploy = (which: "A" | "B") =>
        stack.deploy(
          Effect.gen(function* () {
            const a = yield* Discord.Role("A", { guildId, name: "alchemy-member-a" });
            const b = yield* Discord.Role("B", { guildId, name: "alchemy-member-b" });
            yield* Discord.MemberRole("Assignment", {
              guildId,
              userId,
              roleId: which === "A" ? a.roleId : b.roleId,
            });
            return { a, b };
          }),
        );

      const { a, b } = yield* deploy("A");
      expect(yield* botRoles(guildId, userId)).toContain(a.roleId);

      yield* deploy("B");
      const roles = yield* botRoles(guildId, userId);
      expect(roles).toContain(b.roleId);
      expect(roles).not.toContain(a.roleId);

      yield* stack.destroy();
      const after = yield* botRoles(guildId, userId);
      expect(after).not.toContain(a.roleId);
      expect(after).not.toContain(b.roleId);
    }),
  { tags: tags("member-role"), timeout: 120_000 },
);
