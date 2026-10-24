import * as Azure from "@alchemy.run/azure";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive, withPublicIps } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  applicationGatewayName: string,
  connectionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetApplicationGatewayPrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      applicationGatewayName,
      connectionName,
    }),
  );

const program = (description: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.90.0.0/16"],
    });
    const gatewaySubnet = yield* Azure.Network.Subnet("Gateway", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.90.0.0/24",
    });
    const linkSubnet = yield* Azure.Network.Subnet("PrivateLink", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.90.1.0/24",
      privateLinkServiceNetworkPolicies: "Disabled",
    });
    const consumers = yield* Azure.Network.Subnet("Consumers", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.90.2.0/24",
    });
    const ip = yield* Azure.Network.PublicIpAddress("GatewayIp", {
      resourceGroup: group.resourceGroupName,
    });
    const gateway = yield* Azure.Network.ApplicationGateway("Gateway", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard_v2",
      capacity: 1,
      subnetId: gatewaySubnet.subnetId,
      frontendIpConfigurations: [
        {
          name: "public",
          publicIpAddressId: ip.publicIpAddressId,
          privateLinkConfiguration: "link",
        },
      ],
      privateLinkConfigurations: [
        {
          name: "link",
          ipConfigurations: [{ name: "nat", subnetId: linkSubnet.subnetId, primary: true }],
        },
      ],
      frontendPorts: [{ name: "http", port: 80 }],
      backendAddressPools: [{ name: "web", ipAddresses: ["10.90.3.4"] }],
      backendHttpSettings: [{ name: "http", port: 80, protocol: "Http" }],
      httpListeners: [{ name: "http", frontendIpConfiguration: "public", frontendPort: "http" }],
      requestRoutingRules: [
        {
          name: "web",
          priority: 100,
          httpListener: "http",
          backendAddressPool: "web",
          backendHttpSettings: "http",
        },
      ],
    });
    const endpoint = yield* Azure.Network.PrivateEndpoint("Consumer", {
      resourceGroup: group.resourceGroupName,
      subnetId: consumers.subnetId,
      manualPrivateLinkServiceConnections: [
        {
          privateLinkServiceId: gateway.applicationGatewayId,
          groupIds: ["public"],
          requestMessage: "please",
        },
      ],
    });
    const approval = yield* Azure.Network.ApplicationGatewayConnectionApproval("Approve", {
      resourceGroup: group.resourceGroupName,
      applicationGateway: gateway.applicationGatewayName,
      privateEndpointId: endpoint.privateEndpointId,
      description,
    });
    return { group, gateway, endpoint, approval };
  });

// ~$0.30/run, 40-60 min: a Standard_v2 gateway (~$0.25/hour + capacity
// units) takes 5-15 minutes for each create, update, and delete; the
// private endpoint adds ~$0.01/hour.
test.provider.skipIf(!runExpensive)(
  "approve, update, and remove an application gateway private endpoint connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, gateway, approval } = yield* stack.deploy(program("ok"));
      expect(approval.status).toEqual("Approved");
      const observed = yield* getConnection(
        group.resourceGroupName,
        gateway.applicationGatewayName,
        approval.connectionName,
      );
      expect(observed.properties?.privateLinkServiceConnectionState?.status).toEqual("Approved");
      expect(observed.properties?.privateLinkServiceConnectionState?.description).toEqual("ok");

      const updated = yield* stack.deploy(program("still ok"));
      expect(updated.approval.connectionId).toEqual(approval.connectionId);
      const reobserved = yield* getConnection(
        group.resourceGroupName,
        gateway.applicationGatewayName,
        approval.connectionName,
      );
      expect(reobserved.properties?.privateLinkServiceConnectionState?.description).toEqual(
        "still ok",
      );

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getConnection(
            group.resourceGroupName,
            gateway.applicationGatewayName,
            approval.connectionName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), logLevel),
  { tags, timeout: 7_200_000 },
);
