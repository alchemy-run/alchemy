import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSubnet = (
  resourceGroupName: string,
  virtualNetworkName: string,
  subnetName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetSubnet({
      subscriptionId,
      resourceGroupName,
      virtualNetworkName,
      subnetName,
    }),
  );

const program = (props: {
  associate: boolean;
  serviceEndpoints: string[];
  vnetTags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.0.0.0/16"],
      tags: props.vnetTags,
    });
    const nsg = yield* Azure.Network.NetworkSecurityGroup("Nsg", {
      resourceGroup: group.resourceGroupName,
    });
    const routes = yield* Azure.Network.RouteTable("Routes", {
      resourceGroup: group.resourceGroupName,
    });
    // Two sibling subnets reconcile concurrently; Azure serialises them.
    const app = yield* Azure.Network.Subnet("App", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
      networkSecurityGroupId: props.associate
        ? nsg.networkSecurityGroupId
        : undefined,
      routeTableId: props.associate ? routes.routeTableId : undefined,
      serviceEndpoints: props.serviceEndpoints.map((service) => ({ service })),
    });
    const apps = yield* Azure.Network.Subnet("Apps", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.2.0/24",
      delegations: [{ serviceName: "Microsoft.App/environments" }],
    });
    return { group, vnet, nsg, routes, app, apps };
  });

test.provider(
  "create, update, and delete subnets with associations",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          associate: true,
          serviceEndpoints: ["Microsoft.Storage"],
          vnetTags: { env: "test" },
        }),
      );
      const { group, vnet, nsg, routes, app, apps } = created;
      expect(app.addressPrefix).toEqual("10.0.1.0/24");
      expect(app.networkSecurityGroupId?.toLowerCase()).toEqual(
        nsg.networkSecurityGroupId.toLowerCase(),
      );
      const observedApp = yield* getSubnet(
        group.resourceGroupName,
        vnet.virtualNetworkName,
        app.subnetName,
      );
      expect(observedApp.properties?.provisioningState).toEqual("Succeeded");
      expect(observedApp.properties?.routeTable?.id?.toLowerCase()).toEqual(
        routes.routeTableId.toLowerCase(),
      );
      expect(
        observedApp.properties?.serviceEndpoints?.map((e) => e.service),
      ).toEqual(["Microsoft.Storage"]);
      const observedApps = yield* getSubnet(
        group.resourceGroupName,
        vnet.virtualNetworkName,
        apps.subnetName,
      );
      expect(
        observedApps.properties?.delegations?.map(
          (d) => d.properties?.serviceName,
        ),
      ).toEqual(["Microsoft.App/environments"]);

      // Dissociate NSG + route table, swap the service endpoint, and update
      // the VNet's tags (which must not drop the subnets).
      yield* stack.deploy(
        program({
          associate: false,
          serviceEndpoints: ["Microsoft.KeyVault"],
          vnetTags: { env: "prod" },
        }),
      );
      const updatedApp = yield* getSubnet(
        group.resourceGroupName,
        vnet.virtualNetworkName,
        app.subnetName,
      );
      expect(updatedApp.id).toEqual(observedApp.id);
      expect(updatedApp.properties?.networkSecurityGroup).toBeUndefined();
      expect(updatedApp.properties?.routeTable).toBeUndefined();
      expect(
        updatedApp.properties?.serviceEndpoints?.map((e) => e.service),
      ).toEqual(["Microsoft.KeyVault"]);
      const stillThere = yield* getSubnet(
        group.resourceGroupName,
        vnet.virtualNetworkName,
        apps.subnetName,
      );
      expect(stillThere.properties?.delegations?.length).toEqual(1);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getSubnet(
            group.resourceGroupName,
            vnet.virtualNetworkName,
            app.subnetName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
