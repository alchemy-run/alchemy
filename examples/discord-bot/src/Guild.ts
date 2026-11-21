import * as Discord from "@alchemy.run/discord";
import * as Effect from "effect/Effect";

/** The server the bot was invited to (see README). */
export const Guild = Discord.Guild("Community", { name: "alchemy-test" });

export const Category = Effect.gen(function* () {
  const guild = yield* Guild;
  return yield* Discord.Channel("Bot", { guildId: guild.guildId, name: "Bot", type: "category" });
});

export const Announcements = Effect.gen(function* () {
  const guild = yield* Guild;
  const category = yield* Category;
  return yield* Discord.Channel("Announcements", {
    guildId: guild.guildId,
    name: "announcements",
    parentId: category.channelId,
    permissionOverwrites: [
      { id: guild.everyoneRoleId, type: "role", deny: Discord.Permissions.SendMessages },
    ],
  });
});

export const Deploys = Effect.gen(function* () {
  const guild = yield* Guild;
  const category = yield* Category;
  return yield* Discord.Channel("Deploys", {
    guildId: guild.guildId,
    name: "deploys",
    parentId: category.channelId,
  });
});

export const DeployHook = Effect.gen(function* () {
  const deploys = yield* Deploys;
  return yield* Discord.Webhook("DeployHook", { channelId: deploys.channelId, name: "Deploys" });
});
