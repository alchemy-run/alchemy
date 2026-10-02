import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPool = (
  resourceGroupName: string,
  loadBalancerName: string,
  backendAddressPoolName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetLoadBalancerBackendAddressPool({
      subscriptionId,
      resourceGroupName,
      loadBalancerName,
      backendAddressPoolName,
    }),
  );
const getRule = (
  resourceGroupName: string,
  loadBalancerName: string,
  inboundNatRuleName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetInboundNatRule({
      subscriptionId,
      resourceGroupName,
      loadBalancerName,
      inboundNatRuleName,
    }),
  );

// Internal Standard load balancer ~$0.025/hour (no public IP); the test
// runs for a few minutes (well under $0.01). No VMs.
const program = (props: { address: string; port: number; env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Frontend", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const lb = yield* Azure.Network.LoadBalancer("Internal", {
      resourceGroup: group.resourceGroupName,
      frontendIpConfigurations: [
        { name: "internal", subnetId: subnet.subnetId },
      ],
      tags: { env: props.env },
    });
    const pool = yield* Azure.Network.LoadBalancerBackendAddressPool("Web", {
      resourceGroup: group.resourceGroupName,
      loadBalancer: lb.loadBalancerName,
      virtualNetworkId: vnet.virtualNetworkId,
      addresses: [{ name: "web1", ipAddress: props.address }],
    });
    const rule = yield* Azure.Network.InboundNatRule("Ssh", {
      resourceGroup: group.resourceGroupName,
      loadBalancer: lb.loadBalancerName,
      frontendIpConfiguration: "internal",
      protocol: "Tcp",
      frontendPort: props.port,
      backendPort: 22,
    });
    return { group, lb, pool, rule };
  });

test.provider(
  "create, update, and delete a load balancer backend pool and inbound NAT rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lb, pool, rule } = yield* stack.deploy(
        program({ address: "10.0.1.10", port: 50022, env: "test" }),
      );
      expect(pool.addresses).toEqual([
        { name: "web1", ipAddress: "10.0.1.10" },
      ]);
      expect(rule.frontendPort).toEqual(50022);

      // A load balancer tag update must keep the separately managed pool and rule.
      const updated = yield* stack.deploy(
        program({ address: "10.0.1.11", port: 50023, env: "prod" }),
      );
      expect(updated.pool.backendAddressPoolId).toEqual(
        pool.backendAddressPoolId,
      );
      expect(updated.rule.inboundNatRuleId).toEqual(rule.inboundNatRuleId);
      const observedPool = yield* getPool(
        group.resourceGroupName,
        lb.loadBalancerName,
        pool.backendAddressPoolName,
      );
      expect(
        observedPool.properties?.loadBalancerBackendAddresses?.[0]?.properties
          ?.ipAddress,
      ).toEqual("10.0.1.11");
      const observedRule = yield* getRule(
        group.resourceGroupName,
        lb.loadBalancerName,
        rule.inboundNatRuleName,
      );
      expect(observedRule.properties?.frontendPort).toEqual(50023);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPool(
            group.resourceGroupName,
            lb.loadBalancerName,
            pool.backendAddressPoolName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
