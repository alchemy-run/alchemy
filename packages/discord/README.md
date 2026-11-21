# @alchemy.run/discord

[Discord](https://discord.com) for [Alchemy](https://alchemy.run). Declare a server's channels, roles, webhooks, slash commands and AutoMod rules next to the code that runs your bot.

```sh
npm install alchemy @alchemy.run/discord effect
```

A channel only a role can see, and a webhook that posts into it:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Discord from "@alchemy.run/discord";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "Community",
  {
    providers: Discord.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const guild = yield* Discord.Guild("Community", { name: "My Server" });
    const staff = yield* Discord.Role("Staff", { guildId: guild.guildId, name: "Staff" });
    const room = yield* Discord.Channel("StaffRoom", {
      guildId: guild.guildId,
      name: "staff-room",
      permissionOverwrites: [
        { id: guild.everyoneRoleId, type: "role", deny: Discord.Permissions.ViewChannel },
        { id: staff.roleId, type: "role", allow: Discord.Permissions.ViewChannel },
      ],
    });
    const hook = yield* Discord.Webhook("Alerts", { channelId: room.channelId });
    return { webhookUrl: hook.url };
  }),
);
```

Run `alchemy profile edit --add Discord` and paste your bot's token first. Bindings (`Discord.SendMessage`, `Discord.ExecuteWebhook`, ...) and `Discord.consumeInteractions` call Discord from a Worker or Lambda.

Docs: [alchemy.run/discord](https://alchemy.run/discord) · Reference: [alchemy.run/providers](https://alchemy.run/providers)
