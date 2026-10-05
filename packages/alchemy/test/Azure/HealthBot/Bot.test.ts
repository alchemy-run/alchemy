import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as healthbot from "@distilled.cloud/azure/healthbot";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
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

// F0 is the free tier (~$0, ~1-3 minutes on an eligible subscription). The
// Health Bot backend refuses new bots on the alchemy-testing subscription, on
// the free trial AND on Pay-As-You-Go (verified 2026-10-05): every offered
// region (eastus, eastus2, westus2, westcentralus, southcentralus, uksouth,
// northeurope, southeastasia, australiaeast, centralindia, uaenorth) fails
// the PUT with BadGateway "Server failed to process the request" for F0, C0
// and C1, and westeurope is not accepting new customers. See the probe below.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a health bot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, bot } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(bot.sku).toEqual("F0");
      const observed = yield* getBot(group.resourceGroupName, bot.botName);
      expect(observed.sku.name).toEqual("F0");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toBeDefined();

      // In-place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.bot.botId).toEqual(bot.botId);
      const reobserved = yield* getBot(group.resourceGroupName, bot.botName);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(updated.bot.tags).toEqual({ env: "prod" });

      // Replacement: rename.
      const renamed = `${bot.botName.slice(0, 58)}-r2`;
      const replaced = yield* stack.deploy(
        program({ name: renamed, tags: { env: "prod" } }),
      );
      expect(replaced.bot.botName).toEqual(renamed);
      expect(replaced.bot.botId).not.toEqual(bot.botId);
      expect(
        yield* waitGone(getBot(group.resourceGroupName, bot.botName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getBot(group.resourceGroupName, renamed))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free: a rejected PUT in an empty resource group). The
// Health Bot backend fails every create with a typed BadGateway and nothing
// is provisioned.
test.provider(
  "the health bot backend rejects new bots with BadGateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const subscriptionId = yield* subscription;
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* healthbot
        .CreateBot({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          botName: "alchemy-probe-hb1",
          location: "eastus",
          sku: { name: "F0" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("BadGateway");
      expect(
        yield* waitGone(getBot(group.resourceGroupName, "alchemy-probe-hb1")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
