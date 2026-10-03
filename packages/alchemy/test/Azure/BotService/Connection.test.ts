import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as botservice from "@distilled.cloud/azure/botservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  resourceName: string,
  connectionName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* botservice.GetBotConnection({
      subscriptionId,
      resourceGroupName,
      resourceName,
      connectionName,
    });
  });

const connectionGone = (
  resourceGroupName: string,
  resourceName: string,
  connectionName: string,
) =>
  getConnection(resourceGroupName, resourceName, connectionName).pipe(
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

const parameter = (
  connection: { properties?: botservice.ConnectionSettingProperties },
  key: string,
) => connection.properties?.parameters?.find((p) => p.key === key)?.value;

const RENAMED = "alchemy-renamed-connection";

const program = (connection?: { name?: string; scopes: string }) =>
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
    const created = connection
      ? yield* Azure.BotService.Connection("Connection", {
          resourceGroup: group.resourceGroupName,
          bot: bot.botName,
          name: connection.name,
          serviceProvider: "Aadv2",
          // The Bot Service does not validate OAuth credentials on create.
          clientId: "00000000-0000-0000-0000-000000000001",
          clientSecret: Redacted.make("not-a-real-secret"),
          scopes: connection.scopes,
          parameters: { tenantID: "common" },
        })
      : undefined;
    return { group, bot, connection: created };
  });

// Free: F0 bot, OAuth connection settings cost nothing; seconds to provision.
test.provider(
  "create, update, replace, and delete a bot OAuth connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ scopes: "openid profile" }),
      );
      const rg = created.group.resourceGroupName;
      const botName = created.bot.botName;
      const first = created.connection!;
      expect(first.serviceProviderId).toEqual(
        "30dd229c-58e3-4a48-bdfd-91ec48eb906c",
      );
      expect(first.scopes).toEqual("openid profile");
      const observed = yield* getConnection(rg, botName, first.connectionName);
      expect(observed.properties?.clientId).toEqual(
        "00000000-0000-0000-0000-000000000001",
      );
      expect(parameter(observed, "tenantID")).toEqual("common");

      // In-place update of scopes.
      const updated = yield* stack.deploy(
        program({ scopes: "openid profile User.Read" }),
      );
      expect(updated.connection!.connectionName).toEqual(first.connectionName);
      const reobserved = yield* getConnection(
        rg,
        botName,
        first.connectionName,
      );
      expect(reobserved.properties?.scopes).toEqual("openid profile User.Read");

      // Renaming replaces the connection.
      const renamed = yield* stack.deploy(
        program({ name: RENAMED, scopes: "openid" }),
      );
      expect(renamed.connection!.connectionName).toEqual(RENAMED);
      const replacement = yield* getConnection(rg, botName, RENAMED);
      expect(replacement.properties?.scopes).toEqual("openid");
      expect(yield* connectionGone(rg, botName, first.connectionName)).toEqual(
        "gone",
      );

      // Removing the connection from the stack deletes it.
      yield* stack.deploy(program());
      expect(yield* connectionGone(rg, botName, RENAMED)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:botservice", "live"],
    timeout: 600_000,
  },
);
