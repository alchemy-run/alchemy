import * as Azure from "@alchemy.run/azure";
import * as healthbot from "@distilled.cloud/azure/healthbot";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getBot = (resourceGroupName: string, botName: string) =>
  Effect.gen(function* () {
    return yield* healthbot.GetBot({
      subscriptionId: yield* subscription,
      resourceGroupName,
      botName,
    });
  });

const program = (props: { name?: string; tags?: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const bot = yield* Azure.HealthBot.Bot("Bot", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      location: "eastus",
      tags: props.tags,
    });
    return { group, bot };
  });

// F0 is the free tier: ~$0, create ~1-2 minutes. Earlier runs (2026-10-05)
// saw every create fail with BadGateway; on 2026-10-24 an F0 create in eastus
// reached `Succeeded` in about 1 minute.
test.provider(
  "create, update, replace, and delete a health bot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, bot } = yield* stack.deploy(program({ tags: { env: "test" } }));
      expect(bot.sku).toEqual("F0");
      const observed = yield* getBot(group.resourceGroupName, bot.botName);
      expect(observed.sku.name).toEqual("F0");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Bot");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.bot.botId).toEqual(bot.botId);
      const reobserved = yield* getBot(group.resourceGroupName, bot.botName);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(updated.bot.tags).toEqual({ env: "prod" });

      // Replacement: rename.
      const renamed = `${bot.botName.slice(0, 26).replace(/-+$/, "")}-r2`;
      const replaced = yield* stack.deploy(program({ name: renamed, tags: { env: "prod" } }));
      expect(replaced.bot.botName).toEqual(renamed);
      expect(replaced.bot.botId).not.toEqual(bot.botId);
      expect(yield* waitGone(getBot(group.resourceGroupName, bot.botName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getBot(group.resourceGroupName, renamed))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
