import * as Azure from "@/Azure";
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

const getGateway = (
  resourceGroupName: string,
  applicationGatewayName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetApplicationGateway({
      subscriptionId,
      resourceGroupName,
      applicationGatewayName,
    }),
  );

const program = (props: {
  backends: string[];
  probePath: string;
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
    const subnet = yield* Azure.Network.Subnet("GatewaySubnet", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.0.0/24",
    });
    const ip = yield* Azure.Network.PublicIpAddress("GatewayIp", {
      resourceGroup: group.resourceGroupName,
    });
    const gateway = yield* Azure.Network.ApplicationGateway("Gateway", {
      resourceGroup: group.resourceGroupName,
      sku: "Basic",
      capacity: 1,
      subnetId: subnet.subnetId,
      frontendIpConfigurations: [
        { name: "public", publicIpAddressId: ip.publicIpAddressId },
      ],
      frontendPorts: [{ name: "http", port: 80 }],
      backendAddressPools: [{ name: "web", ipAddresses: props.backends }],
      probes: [
        {
          name: "health",
          protocol: "Http",
          path: props.probePath,
          host: "127.0.0.1",
        },
      ],
      backendHttpSettings: [
        { name: "http", port: 80, protocol: "Http", probe: "health" },
      ],
      httpListeners: [
        {
          name: "http",
          frontendIpConfiguration: "public",
          frontendPort: "http",
        },
      ],
      requestRoutingRules: [
        {
          name: "web",
          priority: 100,
          httpListener: "http",
          backendAddressPool: "web",
          backendHttpSettings: "http",
        },
      ],
      tags: props.tags,
    });
    return { group, ip, gateway };
  });

// Basic Application Gateway ≈ $0.03/hour + capacity units + a Standard
// public IP; create, update, and delete each take 5-15 minutes, so one run
// is ~30-40 minutes (≈ $0.05) — over the 10-minute budget. Runs only with
// AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a Basic application gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, ip, gateway } = yield* stack.deploy(
        program({
          backends: ["10.0.1.4"],
          probePath: "/",
          tags: { env: "test" },
        }),
      );
      expect(gateway.sku).toEqual("Basic");
      expect(gateway.operationalState).toEqual("Running");
      expect(gateway.publicIpAddressIds.map((id) => id.toLowerCase())).toEqual([
        ip.publicIpAddressId.toLowerCase(),
      ]);
      const observed = yield* getGateway(
        group.resourceGroupName,
        gateway.applicationGatewayName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties?.requestRoutingRules?.[0]?.properties?.httpListener?.id
          ?.toLowerCase()
          .endsWith("/httplisteners/http"),
      ).toEqual(true);
      expect(observed.tags?.env).toEqual("test");

      // In-place update of the pool, probe, and tags.
      const updated = yield* stack.deploy(
        program({
          backends: ["10.0.1.4", "10.0.1.5"],
          probePath: "/healthz",
          tags: { env: "prod" },
        }),
      );
      expect(updated.gateway.applicationGatewayId).toEqual(
        gateway.applicationGatewayId,
      );
      const reobserved = yield* getGateway(
        group.resourceGroupName,
        gateway.applicationGatewayName,
      );
      expect(
        (
          reobserved.properties?.backendAddressPools?.[0]?.properties
            ?.backendAddresses ?? []
        )
          .map((a) => a.ipAddress)
          .sort(),
      ).toEqual(["10.0.1.4", "10.0.1.5"]);
      expect(reobserved.properties?.probes?.[0]?.properties?.path).toEqual(
        "/healthz",
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getGateway(group.resourceGroupName, gateway.applicationGatewayName),
        ),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), logLevel),
  { tags, timeout: 7_200_000 },
);
