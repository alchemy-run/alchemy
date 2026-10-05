import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";
import { standardHub } from "./wanFixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGateway = (resourceGroupName: string, gatewayName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetP2sVpnGateway({ subscriptionId, resourceGroupName, gatewayName }),
  );

const program = (dns: string[]) =>
  Effect.gen(function* () {
    const { tenantId } = yield* Azure.AzureEnvironment.current;
    const { group, wan, hub } = yield* standardHub;
    const config = yield* Azure.Network.VpnServerConfiguration("P2s", {
      resourceGroup: group.resourceGroupName,
      vpnAuthenticationTypes: ["AAD"],
      aad: {
        tenant: `https://login.microsoftonline.com/${tenantId}`,
        audience: "c632b3df-fb67-4d84-bdcf-b95ad541b5c8",
        issuer: `https://sts.windows.net/${tenantId}/`,
      },
    });
    const gateway = yield* Azure.Network.P2sVpnGateway("Users", {
      resourceGroup: group.resourceGroupName,
      virtualHubId: hub.virtualHubId,
      vpnServerConfigurationId: config.vpnServerConfigurationId,
      connectionConfigurations: [
        { name: "default", addressPrefixes: ["172.16.0.0/24"] },
      ],
      customDnsServers: dns,
    });
    return { group, wan, hub, config, gateway };
  });

// Standard hub + P2S gateway (~$0.36/hour + connections, 30+ min):
// ≈$1 and over an hour per run.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a point-to-site VPN gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, gateway } = yield* stack.deploy(program(["10.0.0.4"]));
      expect(gateway.connectionConfigurationIds.length).toEqual(1);

      const updated = yield* stack.deploy(program(["10.0.0.4", "10.0.0.5"]));
      expect(updated.gateway.p2sVpnGatewayId).toEqual(gateway.p2sVpnGatewayId);
      const observed = yield* getGateway(
        group.resourceGroupName,
        gateway.p2sVpnGatewayName,
      );
      expect(observed.properties?.customDnsServers).toEqual([
        "10.0.0.4",
        "10.0.0.5",
      ]);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getGateway(group.resourceGroupName, gateway.p2sVpnGatewayName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 10_800_000 },
);
