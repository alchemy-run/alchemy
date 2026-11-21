import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, expectGone, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

const inviteExists = (code: string) =>
  dc(discord.inviteResolve({ code })).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create an invite and replace it when its settings change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;
      const deploy = (maxUses: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const channel = yield* Discord.Channel("Welcome", { guildId, name: "alchemy-invite" });
            return yield* Discord.Invite("Public", { channelId: channel.channelId, maxUses });
          }),
        );

      const v1 = yield* deploy(5);
      expect(v1.url).toBe(`https://discord.gg/${v1.code}`);
      expect(yield* inviteExists(v1.code)).toBe(true);

      // Unchanged redeploy keeps the code.
      expect((yield* deploy(5)).code).toBe(v1.code);

      const v2 = yield* deploy(10);
      expect(v2.code).not.toBe(v1.code);
      yield* expectGone(inviteExists(v1.code));

      yield* stack.destroy();
      yield* expectGone(inviteExists(v2.code));
    }),
  { tags: tags("invite"), timeout: 120_000 },
);
