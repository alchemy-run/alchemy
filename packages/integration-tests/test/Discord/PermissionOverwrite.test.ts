import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

const overwriteOf = (channelId: string, targetId: string) =>
  dc(discord.getChannel({ channel_id: channelId })).pipe(
    Effect.map((c) =>
      ("permission_overwrites" in c ? (c.permission_overwrites ?? []) : []).find(
        (o) => o.id === targetId,
      ),
    ),
  );

test.provider(
  "set, update and remove a role overwrite",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;

      const deploy = (allow: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const role = yield* Discord.Role("Staff", { guildId, name: "alchemy-overwrite" });
            const channel = yield* Discord.Channel("Room", { guildId, name: "alchemy-overwrite" });
            yield* Discord.PermissionOverwrite("StaffCanSee", {
              channelId: channel.channelId,
              targetId: role.roleId,
              type: "role",
              allow,
            });
            return { role, channel };
          }),
        );

      const { role, channel } = yield* deploy(Discord.Permissions.ViewChannel);
      expect((yield* overwriteOf(channel.channelId, role.roleId))?.allow).toBe(
        Discord.Permissions.ViewChannel,
      );

      const more = Discord.combinePermissions(
        Discord.Permissions.ViewChannel,
        Discord.Permissions.SendMessages,
      );
      yield* deploy(more);
      expect((yield* overwriteOf(channel.channelId, role.roleId))?.allow).toBe(more);

      // Drop only the overwrite; the channel stays.
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Discord.Role("Staff", { guildId, name: "alchemy-overwrite" });
          return yield* Discord.Channel("Room", { guildId, name: "alchemy-overwrite" });
        }),
      );
      expect(yield* overwriteOf(channel.channelId, role.roleId)).toBeUndefined();

      yield* stack.destroy();
    }),
  { tags: tags("permission-overwrite"), timeout: 120_000 },
);
