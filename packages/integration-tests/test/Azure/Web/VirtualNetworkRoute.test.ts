import * as Azure from "@alchemy.run/azure";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const getRoute = (resourceGroupName: string, name: string, vnetName: string, routeName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const routes = yield* web.GetAppServicePlanRouteForVnet({
      subscriptionId,
      resourceGroupName,
      name,
      vnetName,
      routeName,
    });
    return routes[0];
  });

const routeGone = (resourceGroupName: string, name: string, vnetName: string, routeName: string) =>
  getRoute(resourceGroupName, name, vnetName, routeName).pipe(
    Effect.map((route) => (route === undefined ? ("gone" as const) : ("found" as const))),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (route: { name: string; startAddress: string; endAddress: string } | undefined) =>
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
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      addressPrefixes: ["10.43.0.0/16"],
    });
    // The app's connection creates the plan's connection the route lives on.
    const integration = yield* Azure.Web.GatewayVirtualNetworkIntegration("Vpn", {
      resourceGroup: group.resourceGroupName,
      siteName: app.siteName,
      virtualNetworkId: vnet.virtualNetworkId,
    });
    const vnetRoute =
      route === undefined
        ? undefined
        : yield* Azure.Web.VirtualNetworkRoute("OnPrem", {
            resourceGroup: group.resourceGroupName,
            appServicePlanName: plan.appServicePlanName,
            vnetName: integration.vnetName,
            name: route.name,
            startAddress: route.startAddress,
            endAddress: route.endAddress,
          });
    return { group, plan, integration, vnetRoute };
  });

// S1 Windows plan: ~$0.10/h, about $0.02 per run (VNets are free; no VPN
// gateway is created). Provisioning: ~3-4 minutes.
// Skipped: AppServicePlansCreateOrUpdateVnetRoute answers HTTP 400
// `BadRequest` "The vnet route given had incorrect fields: ." for both a
// CIDR start address and a start/end range (observed 2026-10-23, S1 Windows
// plan in westus2, connection registered without a VPN gateway).
test.provider.skip(
  "create, update, replace, and delete a plan virtual network route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, plan, integration, vnetRoute } = yield* stack.deploy(
        program({ name: "onprem", startAddress: "10.20.0.0", endAddress: "10.20.255.255" }),
      );
      const planName = plan.appServicePlanName;
      const vnetName = integration.vnetName;
      expect(vnetRoute?.routeName).toEqual("onprem");
      const observed = yield* getRoute(group.resourceGroupName, planName, vnetName, "onprem");
      expect(observed?.properties?.startAddress).toEqual("10.20.0.0");
      expect(observed?.properties?.endAddress).toEqual("10.20.255.255");
      expect(observed?.properties?.routeType).toEqual("STATIC");

      // In-place update: a different range.
      const updated = yield* stack.deploy(
        program({ name: "onprem", startAddress: "10.21.0.0", endAddress: "10.21.255.255" }),
      );
      expect(updated.vnetRoute?.routeId).toEqual(vnetRoute?.routeId);
      const reobserved = yield* getRoute(group.resourceGroupName, planName, vnetName, "onprem");
      expect(reobserved?.properties?.startAddress).toEqual("10.21.0.0");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({ name: "onprem-2", startAddress: "10.21.0.0", endAddress: "10.21.255.255" }),
      );
      expect(replaced.vnetRoute?.routeName).toEqual("onprem-2");
      expect(yield* routeGone(group.resourceGroupName, planName, vnetName, "onprem")).toEqual(
        "gone",
      );

      // Delete only the route.
      yield* stack.deploy(program(undefined));
      expect(yield* routeGone(group.resourceGroupName, planName, vnetName, "onprem-2")).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);
