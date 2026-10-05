import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as botservice from "@distilled.cloud/azure/botservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getChannel = (
  resourceGroupName: string,
  resourceName: string,
  channelName: "DirectLineChannel" | "WebChatChannel",
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* botservice.GetChannel({
      subscriptionId,
      resourceGroupName,
      resourceName,
      channelName,
    });
  });

const channelGone = (
  resourceGroupName: string,
  resourceName: string,
  channelName: "DirectLineChannel" | "WebChatChannel",
) =>
  getChannel(resourceGroupName, resourceName, channelName).pipe(
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

interface SiteView {
  siteName?: string;
  isEnabled?: boolean;
  isV3Enabled?: boolean;
}

const sitesOf = (channel: { properties?: { properties?: unknown } }) =>
  ((channel.properties?.properties as { sites?: SiteView[] } | undefined)
    ?.sites ?? []) as SiteView[];

const program = (directLine?: { isEnabled: boolean }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Identity",
      { resourceGroup: group.resourceGroupName },
    );
    const bot = yield* Azure.BotService.Bot("Bot", {
      resourceGroup: group.resourceGroupName,
      msaAppId: identity.clientId,
      msaAppTenantId: identity.tenantId,
      msaAppMSIResourceId: identity.identityId,
      endpoint: "https://example.com/api/messages",
    });
    const channel = directLine
      ? yield* Azure.BotService.Channel("DirectLine", {
          resourceGroup: group.resourceGroupName,
          bot: bot.botName,
          channelName: "DirectLineChannel",
          properties: {
            sites: [
              {
                siteName: "app",
                isEnabled: directLine.isEnabled,
                isV3Enabled: true,
              },
            ],
          },
        })
      : undefined;
    return { group, bot, channel };
  });

// Free: F0 bot, Direct Line is a standard channel; provisions in seconds.
test.provider(
  "create, update, and delete a Direct Line channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ isEnabled: true }));
      const rg = created.group.resourceGroupName;
      const botName = created.bot.botName;
      const channel = created.channel!;
      expect(channel.channelName).toEqual("DirectLineChannel");
      expect(channel.siteKeys).toHaveLength(1);
      expect(channel.siteKeys[0]!.siteName).toEqual("app");
      expect(Redacted.value(channel.siteKeys[0]!.key!).length).toBeGreaterThan(
        10,
      );
      const observed = yield* getChannel(rg, botName, "DirectLineChannel");
      const sites = sitesOf(observed);
      expect(sites).toHaveLength(1);
      expect(sites[0]!.siteName).toEqual("app");
      expect(sites[0]!.isEnabled).toEqual(true);
      expect(sites[0]!.isV3Enabled).toEqual(true);

      // In-place update of a site setting.
      const updated = yield* stack.deploy(program({ isEnabled: false }));
      expect(updated.channel!.channelId).toEqual(channel.channelId);
      const reobserved = yield* getChannel(rg, botName, "DirectLineChannel");
      const resites = sitesOf(reobserved);
      expect(resites).toHaveLength(1);
      expect(resites[0]!.siteName).toEqual("app");
      expect(resites[0]!.isEnabled).toEqual(false);

      // Removing the channel from the stack deletes it.
      yield* stack.deploy(program());
      expect(yield* channelGone(rg, botName, "DirectLineChannel")).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:botservice", "live"],
    timeout: 600_000,
  },
);
