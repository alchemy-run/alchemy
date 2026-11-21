import * as Slack from "@alchemy.run/slack";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Auth from "@distilled.cloud/slack/auth";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Slack.providers() });

test.provider(
  "captures the profile's bot token and identifies its bot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const token = yield* stack.deploy(Slack.BotToken("Bot"));

      const identity = yield* Auth.testAuth({});
      expect(token.teamId).toBe(identity.team_id);
      expect(token.botUserId).toBe(identity.user_id);
      expect(token.botId).toBe(identity.bot_id);
      expect(Redacted.value(token.value)).toMatch(/^(xoxe\.)?xoxb-/);

      const plan = yield* stack.plan(Slack.BotToken("Bot"));
      expect(plan.resources.Bot?.action).toEqual("noop");

      yield* stack.destroy();
    }),
  { tags: ["provider:slack", "provider:slack:bot-token", "live"], timeout: 60_000 },
);

test.provider(
  "a token Slack rejects fails the deploy with Unauthorized",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const result = yield* stack
        .deploy(Slack.BotToken("Bad", { token: Redacted.make("xoxb-0-0-invalid") }))
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(JSON.stringify(result)).toContain("Unauthorized");
      yield* stack.destroy();
    }),
  { tags: ["provider:slack", "provider:slack:bot-token", "live"], timeout: 60_000 },
);
