import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, expectGone, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

const getRole = (guildId: string, roleId: string) =>
  dc(discord.getGuildRole({ guild_id: guildId, role_id: roleId }));

const roleExists = (guildId: string, roleId: string) =>
  getRole(guildId, roleId).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create and update a role",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;

      const v1 = yield* stack.deploy(
        Discord.Role("Moderator", {
          guildId,
          color: "#5865F2",
          permissions: Discord.Permissions.ManageMessages,
        }),
      );
      expect(v1.mention).toBe(`<@&${v1.roleId}>`);
      const observed1 = yield* getRole(guildId, v1.roleId);
      expect(observed1.color).toBe(0x5865f2);
      expect(observed1.permissions).toBe(Discord.Permissions.ManageMessages);
      expect(observed1.hoist).toBe(false);

      const both = Discord.combinePermissions(
        Discord.Permissions.ManageMessages,
        Discord.Permissions.KickMembers,
      );
      const v2 = yield* stack.deploy(
        Discord.Role("Moderator", {
          guildId,
          name: "alchemy-moderator",
          color: 0xeb459e,
          hoist: true,
          mentionable: true,
          permissions: both,
        }),
      );
      expect(v2.roleId).toBe(v1.roleId);
      const observed2 = yield* getRole(guildId, v1.roleId);
      expect(observed2.name).toBe("alchemy-moderator");
      expect(observed2.color).toBe(0xeb459e);
      expect(observed2.hoist).toBe(true);
      expect(observed2.mentionable).toBe(true);
      expect(observed2.permissions).toBe(both);

      yield* stack.destroy();
      yield* expectGone(roleExists(guildId, v1.roleId));
    }),
  { tags: tags("role"), timeout: 120_000 },
);

test.provider(
  "a role edited out of band converges on redeploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;
      const program = Discord.Role("Drift", { guildId, name: "alchemy-drift", hoist: true });
      const role = yield* stack.deploy(program);
      yield* dc(discord.updateGuildRole({ guild_id: guildId, role_id: role.roleId, hoist: false }));
      yield* stack.deploy(program);
      expect((yield* getRole(guildId, role.roleId)).hoist).toBe(true);
      yield* stack.destroy();
      yield* expectGone(roleExists(guildId, role.roleId));
    }),
  { tags: tags("role"), timeout: 120_000 },
);
