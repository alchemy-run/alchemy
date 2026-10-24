import * as Azure from "@alchemy.run/azure";
import * as relay from "@distilled.cloud/azure/relay";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const getConnection = (
  resourceGroupName: string,
  name: string,
  namespaceName: string,
  relayName: string,
  slot?: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const where = { subscriptionId, resourceGroupName, name, namespaceName, relayName };
    return slot === undefined
      ? yield* web.GetWebAppHybridConnection(where)
      : yield* web.GetWebAppHybridConnectionSlot({ ...where, slot });
  });

const connectionGone = (
  resourceGroupName: string,
  name: string,
  namespaceName: string,
  relayName: string,
  slot?: string,
) =>
  getConnection(resourceGroupName, name, namespaceName, relayName, slot).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

/** Primary key of the `defaultSender` rule (read out of band). */
const senderKey = (
  resourceGroupName: string,
  namespaceName: string,
  hybridConnectionName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const keys = yield* relay.ListHybridConnectionKeys({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      hybridConnectionName,
      authorizationRuleName: "defaultSender",
    });
    return keys.primaryKey ?? "";
  });

const program = (connection: { key: string; port: number; slot: boolean } | undefined) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Hybrid connections need Basic+ and slots Standard; eastus has zero App
    // Service quota, westus2 accepts S1 plans.
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      sku: "S1",
      os: "linux",
    });
    const app = yield* Azure.Web.WebApp("Site", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      os: "linux",
      siteConfig: { alwaysOn: false },
    });
    const slot = yield* Azure.Web.WebAppSlot("Slot", {
      resourceGroup: group.resourceGroupName,
      siteName: app.siteName,
      name: "staging",
      siteConfig: { alwaysOn: false },
    });
    const ns = yield* Azure.Relay.Namespace("Relay", {
      resourceGroup: group.resourceGroupName,
    });
    const hc = yield* Azure.Relay.HybridConnection("Relayed", {
      resourceGroup: group.resourceGroupName,
      namespace: ns.namespaceName,
    });
    const sender = yield* Azure.Relay.HybridConnectionAuthorizationRule("Sender", {
      resourceGroup: group.resourceGroupName,
      namespace: ns.namespaceName,
      hybridConnection: hc.hybridConnectionName,
      name: "defaultSender",
      rights: ["Send"],
    });
    const hybrid =
      connection === undefined
        ? undefined
        : yield* Azure.Web.HybridConnection("OnPrem", {
            resourceGroup: group.resourceGroupName,
            siteName: app.siteName,
            slot: connection.slot ? slot.slotName : undefined,
            namespaceName: ns.namespaceName,
            relayName: hc.hybridConnectionName,
            relayArmUri: hc.hybridConnectionId,
            hostname: "sql01.corp.example.com",
            port: connection.port,
            sendKeyName: sender.authorizationRuleName,
            sendKeyValue: Redacted.make(connection.key),
          });
    return { group, app, ns, hc, hybrid };
  });

// S1 plan: ~$0.10/h, about $0.02 per run; a Relay namespace with no
// listeners costs ~$0. Provisioning: ~3-4 minutes.
test.provider(
  "connect, update, move to a slot, and remove an app hybrid connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = yield* stack.deploy(program(undefined));
      const namespaceName = base.ns.namespaceName;
      const relayName = base.hc.hybridConnectionName;
      const key = yield* senderKey(base.group.resourceGroupName, namespaceName, relayName);
      expect(key.length).toBeGreaterThan(0);

      const { group, app, hybrid } = yield* stack.deploy(program({ key, port: 1433, slot: false }));
      expect(hybrid?.port).toEqual(1433);
      const observed = yield* getConnection(
        group.resourceGroupName,
        app.siteName,
        namespaceName,
        relayName,
      );
      expect(observed.properties?.hostname).toEqual("sql01.corp.example.com");
      expect(observed.properties?.port).toEqual(1433);
      expect(observed.properties?.sendKeyName).toEqual("defaultSender");

      // In-place update: a different port.
      const updated = yield* stack.deploy(program({ key, port: 1434, slot: false }));
      expect(updated.hybrid?.hybridConnectionId).toEqual(hybrid?.hybridConnectionId);
      const reobserved = yield* getConnection(
        group.resourceGroupName,
        app.siteName,
        namespaceName,
        relayName,
      );
      expect(reobserved.properties?.port).toEqual(1434);

      // Replacement: move the connection to the staging slot.
      const moved = yield* stack.deploy(program({ key, port: 1434, slot: true }));
      expect(moved.hybrid?.slot).toEqual("staging");
      const inSlot = yield* getConnection(
        group.resourceGroupName,
        app.siteName,
        namespaceName,
        relayName,
        "staging",
      );
      expect(inSlot.properties?.port).toEqual(1434);
      expect(
        yield* connectionGone(group.resourceGroupName, app.siteName, namespaceName, relayName),
      ).toEqual("gone");

      // Remove only the connection.
      yield* stack.deploy(program(undefined));
      expect(
        yield* connectionGone(
          group.resourceGroupName,
          app.siteName,
          namespaceName,
          relayName,
          "staging",
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);
