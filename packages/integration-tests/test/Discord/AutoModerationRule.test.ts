import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, expectGone, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

test.provider(
  "create, update and replace an AutoMod rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;
      const getRule = (ruleId: string) =>
        dc(discord.getAutoModerationRule({ guild_id: guildId, rule_id: ruleId }));
      const exists = (ruleId: string) =>
        getRule(ruleId).pipe(
          Effect.as(true),
          Effect.catchTag("NotFound", () => Effect.succeed(false)),
        );

      const deploy = (rule: Omit<Discord.AutoModerationRuleProps, "guildId">) =>
        stack.deploy(Discord.AutoModerationRule("NoInvites", { guildId, ...rule }));

      const v1 = yield* deploy({
        name: "alchemy no invites",
        trigger: { type: "keyword", keywordFilter: ["discord.gg/*"] },
        actions: [{ type: "blockMessage", customMessage: "No invites" }],
      });
      expect(v1.triggerType).toBe("keyword");
      expect((yield* getRule(v1.ruleId)).enabled).toBe(true);

      const v2 = yield* deploy({
        name: "alchemy no invites",
        trigger: { type: "keyword", keywordFilter: ["discord.gg/*", "discord.com/invite/*"] },
        actions: [{ type: "blockMessage" }],
        enabled: false,
      });
      expect(v2.ruleId).toBe(v1.ruleId);
      const observed = yield* getRule(v1.ruleId);
      expect(observed.enabled).toBe(false);
      expect((observed.trigger_metadata as { keyword_filter: string[] }).keyword_filter).toEqual([
        "discord.gg/*",
        "discord.com/invite/*",
      ]);

      // A different trigger type is a new rule.
      const v3 = yield* deploy({
        name: "alchemy mention spam",
        trigger: { type: "mentionSpam", mentionTotalLimit: 20 },
        actions: [{ type: "blockMessage" }],
      });
      expect(v3.ruleId).not.toBe(v1.ruleId);
      yield* expectGone(exists(v1.ruleId));

      yield* stack.destroy();
      yield* expectGone(exists(v3.ruleId));
    }),
  { tags: tags("auto-moderation-rule"), timeout: 120_000 },
);
