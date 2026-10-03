import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  subscriptionId,
  tags,
  untilGone,
  withPublicIps,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getLb = (resourceGroupName: string, loadBalancerName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetLoadBalancer({
      subscriptionId,
      resourceGroupName,
      loadBalancerName,
    }),
  );

// Standard load balancer ~$0.025/hour + public IP ~$0.005/hour; the test
// runs for a few minutes (well under $0.01). No VMs.
const program = (props: { https: boolean; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const ip = yield* Azure.Network.PublicIpAddress("Lb", {
      resourceGroup: group.resourceGroupName,
    });
    const lb = yield* Azure.Network.LoadBalancer("Web", {
      resourceGroup: group.resourceGroupName,
      frontendIpConfigurations: [
        { name: "public", publicIpAddressId: ip.publicIpAddressId },
      ],
      backendAddressPools: [{ name: "web" }],
      probes: [{ name: "http", protocol: "Http", port: 80, requestPath: "/" }],
      loadBalancingRules: [
        {
          name: "http",
          frontendIpConfiguration: "public",
          backendAddressPool: "web",
          probe: "http",
          protocol: "Tcp",
          frontendPort: 80,
          disableOutboundSnat: true,
        },
        ...(props.https
          ? [
              {
                name: "https",
                frontendIpConfiguration: "public",
                backendAddressPool: "web",
                probe: "http",
                protocol: "Tcp" as const,
                frontendPort: 443,
                disableOutboundSnat: true,
                enableTcpReset: true,
              },
            ]
          : []),
      ],
      tags: props.tags,
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Backend", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const nic = yield* Azure.Network.NetworkInterface("Web1", {
      resourceGroup: group.resourceGroupName,
      ipConfigurations: [
        {
          subnetId: subnet.subnetId,
          loadBalancerBackendAddressPoolIds: [lb.backendAddressPoolIds.web],
        },
      ],
    });
    return { group, ip, lb, nic };
  });

test.provider(
  "create, update, and delete a public load balancer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lb, nic } = yield* stack.deploy(
        program({ https: false, tags: { env: "test" } }),
      );
      expect(lb.sku).toEqual("Standard");
      expect(Object.keys(lb.backendAddressPoolIds)).toEqual(["web"]);
      expect(Object.keys(lb.probeIds)).toEqual(["http"]);
      const observed = yield* getLb(
        group.resourceGroupName,
        lb.loadBalancerName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties?.loadBalancingRules?.map((rule) => rule.name),
      ).toEqual(["http"]);
      expect(observed.tags?.env).toEqual("test");
      const pool = observed.properties?.backendAddressPools?.[0];
      expect(
        pool?.properties?.backendIPConfigurations?.map((c) =>
          c.id?.toLowerCase().startsWith(nic.networkInterfaceId.toLowerCase()),
        ),
      ).toEqual([true]);

      const updated = yield* stack.deploy(
        program({ https: true, tags: { env: "prod" } }),
      );
      expect(updated.lb.loadBalancerId).toEqual(lb.loadBalancerId);
      const reobserved = yield* getLb(
        group.resourceGroupName,
        lb.loadBalancerName,
      );
      expect(
        reobserved.properties?.loadBalancingRules
          ?.map((rule) => rule.name)
          .sort(),
      ).toEqual(["http", "https"]);
      const https = reobserved.properties?.loadBalancingRules?.find(
        (rule) => rule.name === "https",
      );
      expect(https?.properties?.frontendPort).toEqual(443);
      expect(https?.properties?.enableTcpReset).toEqual(true);
      expect(reobserved.tags?.env).toEqual("prod");
      // The NIC's pool membership survives the LB PUT.
      expect(
        reobserved.properties?.backendAddressPools?.[0]?.properties
          ?.backendIPConfigurations?.length,
      ).toEqual(1);

      yield* stack.destroy();
      expect(
        yield* untilGone(getLb(group.resourceGroupName, lb.loadBalancerName)),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), logLevel),
  { tags, timeout: 600_000 },
);
