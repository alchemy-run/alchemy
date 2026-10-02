import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getService = (resourceGroupName: string, serviceName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetPrivateLinkService({
      subscriptionId,
      resourceGroupName,
      serviceName,
    }),
  );
const getConnection = (
  resourceGroupName: string,
  serviceName: string,
  peConnectionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetPrivateLinkServicePrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      serviceName,
      peConnectionName,
    }),
  );

// Internal Standard LB ~$0.025/hour, private link service + one private
// endpoint ~$0.02/hour; the test runs for a few minutes (< $0.01).
const program = (props: {
  proxyProtocol: boolean;
  description: string;
  env: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const frontend = yield* Azure.Network.Subnet("Frontend", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
      privateLinkServiceNetworkPolicies: "Disabled",
    });
    const consumers = yield* Azure.Network.Subnet("Consumers", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.2.0/24",
    });
    const lb = yield* Azure.Network.LoadBalancer("Internal", {
      resourceGroup: group.resourceGroupName,
      frontendIpConfigurations: [
        { name: "internal", subnetId: frontend.subnetId },
      ],
    });
    const service = yield* Azure.Network.PrivateLinkService("Api", {
      resourceGroup: group.resourceGroupName,
      loadBalancerFrontendIpConfigurationIds: [
        Output.interpolate`${lb.loadBalancerId}/frontendIPConfigurations/internal`,
      ],
      ipConfigurations: [
        { name: "nat", subnetId: frontend.subnetId, primary: true },
      ],
      enableProxyProtocol: props.proxyProtocol,
      tags: { env: props.env },
    });
    const endpoint = yield* Azure.Network.PrivateEndpoint("Consumer", {
      resourceGroup: group.resourceGroupName,
      subnetId: consumers.subnetId,
      manualPrivateLinkServiceConnections: [
        {
          privateLinkServiceId: service.privateLinkServiceId,
          requestMessage: "please",
        },
      ],
    });
    const approval = yield* Azure.Network.PrivateLinkServiceConnectionApproval(
      "Approve",
      {
        resourceGroup: group.resourceGroupName,
        privateLinkService: service.privateLinkServiceName,
        privateEndpointId: endpoint.privateEndpointId,
        description: props.description,
      },
    );
    return { group, service, endpoint, approval };
  });

test.provider(
  "approve, update, and remove a private link service connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service, approval } = yield* stack.deploy(
        program({ proxyProtocol: false, description: "ok", env: "test" }),
      );
      expect(service.alias).toBeDefined();
      expect(approval.status).toEqual("Approved");
      const observed = yield* getConnection(
        group.resourceGroupName,
        service.privateLinkServiceName,
        approval.connectionName,
      );
      expect(
        observed.properties?.privateLinkServiceConnectionState?.status,
      ).toEqual("Approved");
      expect(
        observed.properties?.privateLinkServiceConnectionState?.description,
      ).toEqual("ok");

      const updated = yield* stack.deploy(
        program({ proxyProtocol: true, description: "still ok", env: "prod" }),
      );
      expect(updated.service.privateLinkServiceId).toEqual(
        service.privateLinkServiceId,
      );
      const reobserved = yield* getService(
        group.resourceGroupName,
        service.privateLinkServiceName,
      );
      expect(reobserved.properties?.enableProxyProtocol).toEqual(true);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(
        (yield* getConnection(
          group.resourceGroupName,
          service.privateLinkServiceName,
          approval.connectionName,
        )).properties?.privateLinkServiceConnectionState?.description,
      ).toEqual("still ok");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getService(group.resourceGroupName, service.privateLinkServiceName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
