import * as Azure from "@alchemy.run/azure";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const getConnection = (resourceGroupName: string, name: string, vnetName: string, slot?: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const where = { subscriptionId, resourceGroupName, name, vnetName };
    return slot === undefined
      ? yield* web.GetWebAppVnetConnection(where)
      : yield* web.GetWebAppVnetConnectionSlot({ ...where, slot });
  });

const connectionGone = (resourceGroupName: string, name: string, vnetName: string, slot?: string) =>
  getConnection(resourceGroupName, name, vnetName, slot).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (integration: { slot: boolean } | undefined) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Gateway-required integration needs a Standard+ Windows plan; eastus
    // has zero App Service quota, westus2 accepts S1 plans.
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      sku: "S1",
      os: "windows",
    });
    const app = yield* Azure.Web.WebApp("Site", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      os: "windows",
      siteConfig: { alwaysOn: false },
    });
    const slot = yield* Azure.Web.WebAppSlot("Slot", {
      resourceGroup: group.resourceGroupName,
      siteName: app.siteName,
      name: "staging",
      siteConfig: { alwaysOn: false },
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      addressPrefixes: ["10.42.0.0/16"],
    });
    const connection =
      integration === undefined
        ? undefined
        : yield* Azure.Web.GatewayVirtualNetworkIntegration("Vpn", {
            resourceGroup: group.resourceGroupName,
            siteName: app.siteName,
            slot: integration.slot ? slot.slotName : undefined,
            virtualNetworkId: vnet.virtualNetworkId,
          });
    return { group, app, vnet, connection };
  });

// S1 Windows plan: ~$0.10/h, about $0.02 per run (VNets are free). The
// point-to-site gateway itself (VpnGw1, ~$0.19/h, 30-45 minutes to
// provision) is not created: the connection registers without it.
// Provisioning: ~3-4 minutes.
test.provider(
  "register, move to a slot, and remove a gateway-required integration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, app, vnet, connection } = yield* stack.deploy(program({ slot: false }));
      const vnetName = vnet.virtualNetworkName;
      expect(connection?.vnetName).toEqual(vnetName);
      expect(connection?.virtualNetworkId.toLowerCase()).toEqual(
        vnet.virtualNetworkId.toLowerCase(),
      );
      const observed = yield* getConnection(group.resourceGroupName, app.siteName, vnetName);
      expect(observed.properties?.vnetResourceId?.toLowerCase()).toEqual(
        vnet.virtualNetworkId.toLowerCase(),
      );
      // App Service generates the point-to-site client certificate.
      expect(connection?.certThumbprint).toEqual(observed.properties?.certThumbprint);

      expect(connection?.certBlob).toEqual(observed.properties?.certBlob);

      // A redeploy without changes keeps the connection and its certificate.
      const same = yield* stack.deploy(program({ slot: false }));
      expect(same.connection?.connectionId).toEqual(connection?.connectionId);
      expect(same.connection?.certThumbprint).toEqual(connection?.certThumbprint);

      // Replacement: move the integration to the staging slot.
      const moved = yield* stack.deploy(program({ slot: true }));
      expect(moved.connection?.slot).toEqual("staging");
      const inSlot = yield* getConnection(
        group.resourceGroupName,
        app.siteName,
        vnetName,
        "staging",
      );
      expect(inSlot.properties?.vnetResourceId?.toLowerCase()).toEqual(
        vnet.virtualNetworkId.toLowerCase(),
      );
      expect(yield* connectionGone(group.resourceGroupName, app.siteName, vnetName)).toEqual(
        "gone",
      );

      // Remove only the integration.
      yield* stack.deploy(program(undefined));
      expect(
        yield* connectionGone(group.resourceGroupName, app.siteName, vnetName, "staging"),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);
