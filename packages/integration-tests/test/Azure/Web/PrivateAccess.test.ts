import * as Azure from "@alchemy.run/azure";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

/** `{ enabled, networks }` as Azure reports them (networks as `vnetId:subnets`). */
const observeAccess = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const observed = yield* web.GetWebAppPrivateAccess({
      subscriptionId,
      resourceGroupName,
      name,
    });
    return {
      enabled: observed.properties?.enabled ?? false,
      networks: (observed.properties?.virtualNetworks ?? []).map(
        (vnet) =>
          `${vnet.resourceId?.toLowerCase()}:${(vnet.subnets ?? []).map((s) => s.name).join(",")}`,
      ),
    };
  });

const program = (access: { subnets: string[] | undefined } | undefined) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // eastus has zero App Service quota; westus2 accepts S1 plans (its F1
    // capacity is often exhausted: "No available instances to satisfy this
    // request").
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
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      addressPrefixes: ["10.41.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Apps", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      name: "apps",
      addressPrefix: "10.41.1.0/24",
    });
    const privateAccess =
      access === undefined
        ? undefined
        : yield* Azure.Web.PrivateAccess("Private", {
            resourceGroup: group.resourceGroupName,
            siteName: app.siteName,
            virtualNetworks: [
              {
                virtualNetworkId: vnet.virtualNetworkId,
                subnets: access.subnets === undefined ? undefined : [subnet.subnetName],
              },
            ],
          });
    return { group, app, vnet, privateAccess };
  });

// S1 plan: ~$0.10/h, about $0.02 per run (VNets are free). Provisioning:
// ~2-3 minutes.
test.provider(
  "enable, narrow, and disable private site access",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, app, vnet, privateAccess } = yield* stack.deploy(
        program({ subnets: undefined }),
      );
      const vnetId = vnet.virtualNetworkId.toLowerCase();
      expect(privateAccess?.enabled).toEqual(true);
      expect(yield* observeAccess(group.resourceGroupName, app.siteName)).toEqual({
        enabled: true,
        networks: [`${vnetId}:`],
      });

      // In-place update: allow one subnet only.
      yield* stack.deploy(program({ subnets: ["apps"] }));
      expect(yield* observeAccess(group.resourceGroupName, app.siteName)).toEqual({
        enabled: true,
        networks: [`${vnetId}:apps`],
      });

      // Removing the resource disables private access and clears the list.
      yield* stack.deploy(program(undefined));
      expect(yield* observeAccess(group.resourceGroupName, app.siteName)).toEqual({
        enabled: false,
        networks: [],
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
