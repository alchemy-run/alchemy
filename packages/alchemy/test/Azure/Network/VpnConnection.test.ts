import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";
import { standardHub } from "./wanFixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  gatewayName: string,
  connectionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVpnConnection({
      subscriptionId,
      resourceGroupName,
      gatewayName,
      connectionName,
    }),
  );

const program = (bandwidthMbps: number) =>
  Effect.gen(function* () {
    const { group, wan, hub } = yield* standardHub;
    const site = yield* Azure.Network.VpnSite("Branch", {
      resourceGroup: group.resourceGroupName,
      virtualWanId: wan.virtualWanId,
      addressPrefixes: ["10.20.0.0/16"],
      links: [{ name: "isp1", ipAddress: "203.0.113.10", speedInMbps: 100 }],
    });
    const gateway = yield* Azure.Network.VpnGateway("S2s", {
      resourceGroup: group.resourceGroupName,
      virtualHubId: hub.virtualHubId,
    });
    const connection = yield* Azure.Network.VpnConnection("BranchConnection", {
      resourceGroup: group.resourceGroupName,
      vpnGateway: gateway.vpnGatewayName,
      remoteVpnSiteId: site.vpnSiteId,
      links: [
        {
          name: "isp1",
          vpnSiteLinkId: Output.map(site.linkIds, (ids) => ids[0]!),
          sharedKey: Redacted.make("alchemy-test-shared-key-1"),
          bandwidthMbps,
        },
      ],
    });
    return { group, wan, hub, site, gateway, connection };
  });

// Standard hub + VPN gateway: ≈$1 and over an hour per run.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a Virtual WAN VPN connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, gateway, site, connection } = yield* stack.deploy(
        program(10),
      );
      expect(connection.remoteVpnSiteId?.toLowerCase()).toEqual(
        site.vpnSiteId.toLowerCase(),
      );

      const updated = yield* stack.deploy(program(20));
      expect(updated.connection.connectionId).toEqual(connection.connectionId);
      const observed = yield* getConnection(
        group.resourceGroupName,
        gateway.vpnGatewayName,
        connection.connectionName,
      );
      expect(
        observed.properties?.vpnLinkConnections?.[0]?.properties
          ?.connectionBandwidth,
      ).toEqual(20);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getConnection(
            group.resourceGroupName,
            gateway.vpnGatewayName,
            connection.connectionName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
