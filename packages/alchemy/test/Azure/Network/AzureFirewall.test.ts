import * as Azure from "@/Azure";
import { orUndefinedIfNotFound, waitForProvisioned } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  logLevel,
  subscriptionId,
  tags,
  untilGone,
  withPublicIps,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const POLICY = "alchemy-test-firewall-policy";

const getFirewall = (resourceGroupName: string, azureFirewallName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetAzureFirewall({
      subscriptionId,
      resourceGroupName,
      azureFirewallName,
    }),
  );

const getPolicy = (resourceGroupName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetFirewallPolicy({
      subscriptionId,
      resourceGroupName,
      firewallPolicyName: POLICY,
    }),
  );

// Azure.Network.FirewallPolicy is not implemented yet: the Basic policy is
// created out-of-band inside the stack's resource group.
const createPolicy = (resourceGroupName: string) =>
  Effect.gen(function* () {
    yield* network.FirewallPoliciesCreateOrUpdate({
      subscriptionId: yield* subscriptionId,
      resourceGroupName,
      firewallPolicyName: POLICY,
      location: "eastus",
      properties: { sku: { tier: "Basic" } },
    });
    return yield* waitForProvisioned(
      `firewall policy ${POLICY}`,
      orUndefinedIfNotFound(getPolicy(resourceGroupName)),
      (policy) => policy.properties?.provisioningState,
      { interval: "5 seconds", times: 60 },
    );
  });

const program = (props: {
  policyId?: string;
  dnsProxy: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("FirewallSubnet", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      name: "AzureFirewallSubnet",
      addressPrefix: "10.0.0.0/26",
    });
    const managementSubnet = yield* Azure.Network.Subnet("ManagementSubnet", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      name: "AzureFirewallManagementSubnet",
      addressPrefix: "10.0.1.0/26",
    });
    const ip = yield* Azure.Network.PublicIpAddress("FirewallIp", {
      resourceGroup: group.resourceGroupName,
    });
    const managementIp = yield* Azure.Network.PublicIpAddress("ManagementIp", {
      resourceGroup: group.resourceGroupName,
    });
    const firewall =
      props.policyId === undefined
        ? undefined
        : yield* Azure.Network.AzureFirewall("Firewall", {
            resourceGroup: group.resourceGroupName,
            skuTier: "Basic",
            firewallPolicyId: props.policyId,
            ipConfigurations: [
              {
                subnetId: subnet.subnetId,
                publicIpAddressId: ip.publicIpAddressId,
              },
            ],
            managementIpConfiguration: {
              subnetId: managementSubnet.subnetId,
              publicIpAddressId: managementIp.publicIpAddressId,
            },
            additionalProperties: props.dnsProxy
              ? { "Network.DNS.EnableProxy": "true" }
              : undefined,
            tags: props.tags,
          });
    return { group, firewall };
  });

// Basic firewall ≈ $0.40/hour + 2 Standard public IPs; create and delete
// each take 5-15 minutes, so one run is ~30-45 minutes (≈ $0.30) — over
// the 10-minute budget. Runs only with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a Basic Azure Firewall",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        program({ dnsProxy: false, tags: { env: "test" } }),
      );
      const policy = yield* createPolicy(group.resourceGroupName);
      const policyId = policy.id!;

      const { firewall } = yield* stack.deploy(
        program({ policyId, dnsProxy: false, tags: { env: "test" } }),
      );
      expect(firewall!.skuTier).toEqual("Basic");
      expect(firewall!.privateIpAddress).toMatch(/^10\.0\.0\.\d+$/);
      expect(firewall!.firewallPolicyId?.toLowerCase()).toEqual(
        policyId.toLowerCase(),
      );
      const observed = yield* getFirewall(
        group.resourceGroupName,
        firewall!.azureFirewallName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.managementIpConfiguration).toBeDefined();
      expect(observed.tags?.env).toEqual("test");

      // In-place update: DNS proxy + tags.
      const updated = yield* stack.deploy(
        program({ policyId, dnsProxy: true, tags: { env: "prod" } }),
      );
      expect(updated.firewall!.azureFirewallId).toEqual(
        firewall!.azureFirewallId,
      );
      const reobserved = yield* getFirewall(
        group.resourceGroupName,
        firewall!.azureFirewallName,
      );
      expect(
        reobserved.properties?.additionalProperties?.[
          "Network.DNS.EnableProxy"
        ],
      ).toEqual("true");
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getFirewall(group.resourceGroupName, firewall!.azureFirewallName),
        ),
      ).toEqual("gone");
    }).pipe(withPublicIps(2), logLevel),
  { tags, timeout: 3_600_000 },
);
