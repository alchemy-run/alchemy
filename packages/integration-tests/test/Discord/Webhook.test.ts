import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { dc, expectGone, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

const webhookExists = (webhookId: string) =>
  dc(discord.getWebhook({ webhook_id: webhookId })).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create, rename and move a webhook",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;

      const deploy = (name: string | undefined, which: "A" | "B") =>
        stack.deploy(
          Effect.gen(function* () {
            const a = yield* Discord.Channel("A", { guildId, name: "alchemy-hook-a" });
            const b = yield* Discord.Channel("B", { guildId, name: "alchemy-hook-b" });
            const hook = yield* Discord.Webhook("Hook", {
              channelId: which === "A" ? a.channelId : b.channelId,
              name,
            });
            return { a, b, hook };
          }),
        );

      const v1 = yield* deploy(undefined, "A");
      expect(Redacted.isRedacted(v1.hook.token)).toBe(true);
      expect(Redacted.value(v1.hook.url)).toBe(
        `https://discord.com/api/webhooks/${v1.hook.webhookId}/${Redacted.value(v1.hook.token)}`,
      );
      expect(v1.hook.name.toLowerCase()).not.toContain("discord");

      // The token works without a bot token.
      const byToken = yield* dc(
        discord.getWebhookByToken({ webhook_id: v1.hook.webhookId, webhook_token: v1.hook.token }),
      );
      expect(byToken.id).toBe(v1.hook.webhookId);

      const v2 = yield* deploy("Deploy Bot", "B");
      expect(v2.hook.webhookId).toBe(v1.hook.webhookId);
      const observed = yield* dc(discord.getWebhook({ webhook_id: v1.hook.webhookId }));
      expect(observed.name).toBe("Deploy Bot");
      expect(observed.channel_id).toBe(v2.b.channelId);

      yield* stack.destroy();
      yield* expectGone(webhookExists(v1.hook.webhookId));
    }),
  { tags: tags("webhook"), timeout: 120_000 },
);
