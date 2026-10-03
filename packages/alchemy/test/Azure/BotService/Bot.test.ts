import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as botservice from "@distilled.cloud/azure/botservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getBot = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* botservice.GetBot({
      subscriptionId,
      resourceGroupName,
      resourceName,
    });
  });

const botGone = (resourceGroupName: string, resourceName: string) =>
  getBot(resourceGroupName, resourceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const RENAMED = "alchemy-botsvc-test-renamed";

const program = (bot?: {
  name?: string;
  displayName: string;
  endpoint: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Identity",
      { resourceGroup: group.resourceGroupName },
    );
    const created = bot
      ? yield* Azure.BotService.Bot("Bot", {
          resourceGroup: group.resourceGroupName,
          name: bot.name,
          msaAppId: identity.clientId,
          msaAppTenantId: identity.tenantId,
          msaAppMSIResourceId: identity.identityId,
          displayName: bot.displayName,
          endpoint: bot.endpoint,
          tags: bot.tags,
        })
      : undefined;
    return { group, identity, bot: created };
  });

// Free: F0 bots cost nothing; provisions in seconds.
test.provider(
  "create, update, replace, and delete a bot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          displayName: "Alchemy Test Bot",
          endpoint: "https://example.com/api/messages",
          tags: { env: "test" },
        }),
      );
      const rg = created.group.resourceGroupName;
      const first = created.bot!;
      expect(first.msaAppType).toEqual("UserAssignedMSI");
      expect(first.msaAppId).toEqual(created.identity.clientId);
      expect(first.sku).toEqual("F0");
      expect(first.tags).toEqual({ env: "test" });
      const observed = yield* getBot(rg, first.botName);
      expect(observed.properties?.displayName).toEqual("Alchemy Test Bot");
      expect(observed.properties?.endpoint).toEqual(
        "https://example.com/api/messages",
      );
      expect(observed.tags?.["alchemy::id"]).toEqual("Bot");

      // In-place update of display name, endpoint, and tags.
      const updated = yield* stack.deploy(
        program({
          displayName: "Alchemy Test Bot v2",
          endpoint: "https://example.org/api/messages",
          tags: { env: "staging", owner: "ops" },
        }),
      );
      expect(updated.bot!.botName).toEqual(first.botName);
      expect(updated.bot!.botId).toEqual(first.botId);
      const reobserved = yield* getBot(rg, first.botName);
      expect(reobserved.properties?.displayName).toEqual("Alchemy Test Bot v2");
      expect(reobserved.properties?.endpoint).toEqual(
        "https://example.org/api/messages",
      );
      expect(reobserved.tags?.env).toEqual("staging");
      expect(reobserved.tags?.owner).toEqual("ops");

      // Renaming replaces the bot.
      const renamed = yield* stack.deploy(
        program({
          name: RENAMED,
          displayName: "Renamed",
          endpoint: "https://example.org/api/messages",
          tags: {},
        }),
      );
      expect(renamed.bot!.botName).toEqual(RENAMED);
      const replacement = yield* getBot(rg, RENAMED);
      expect(replacement.properties?.displayName).toEqual("Renamed");
      expect(yield* botGone(rg, first.botName)).toEqual("gone");

      // Removing the bot from the stack deletes it.
      yield* stack.deploy(program());
      expect(yield* botGone(rg, RENAMED)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:botservice", "live"],
    timeout: 600_000,
  },
);
