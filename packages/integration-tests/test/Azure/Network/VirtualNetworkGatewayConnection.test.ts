import * as Azure from "@alchemy.run/azure";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runExpensive, withPublicIps } from "../gates.ts";
import { vpnGateway } from "./gatewayFixtures.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (resourceGroupName: string, virtualNetworkGatewayConnectionName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVirtualNetworkGatewayConnection({
      subscriptionId,
      resourceGroupName,
      virtualNetworkGatewayConnectionName,
    }),
  );

const program = (props: { dpdTimeoutSeconds: number; env: string }) =>
  Effect.gen(function* () {
    const { group, gateway } = yield* vpnGateway({ sku: "VpnGw1AZ" });
    // A documentation address (RFC 5737): the tunnel never comes up.
    const site = yield* Azure.Network.LocalNetworkGateway("Office", {
      resourceGroup: group.resourceGroupName,
      gatewayIpAddress: "203.0.113.10",
      addressPrefixes: ["192.168.0.0/24"],
    });
    const connection = yield* Azure.Network.VirtualNetworkGatewayConnection("Office", {
      resourceGroup: group.resourceGroupName,
      connectionType: "IPsec",
      virtualNetworkGatewayId: gateway.virtualNetworkGatewayId,
      localNetworkGatewayId: site.localNetworkGatewayId,
      sharedKey: Redacted.make("alchemy-test-shared-key"),
      dpdTimeoutSeconds: props.dpdTimeoutSeconds,
      tags: { env: props.env },
    });
    return { group, gateway, site, connection };
  });

// ~$0.50/run, 60-90 min: VpnGw1AZ (~$0.19/hour) takes 30-45 minutes to
// create and 10-20 minutes to delete; the connection itself is billed
// only while connected.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a site-to-site VPN connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, gateway, connection } = yield* stack.deploy(
        program({ dpdTimeoutSeconds: 45, env: "test" }),
      );
      expect(connection.connectionType).toEqual("IPsec");
      expect(connection.virtualNetworkGatewayId?.toLowerCase()).toEqual(
        gateway.virtualNetworkGatewayId.toLowerCase(),
      );
      const observed = yield* getConnection(group.resourceGroupName, connection.connectionName);
      expect(observed.properties?.dpdTimeoutSeconds).toEqual(45);
      expect(observed.properties?.connectionProtocol).toEqual("IKEv2");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(program({ dpdTimeoutSeconds: 60, env: "prod" }));
      expect(updated.connection.connectionId).toEqual(connection.connectionId);
      const reobserved = yield* getConnection(group.resourceGroupName, connection.connectionName);
      expect(reobserved.properties?.dpdTimeoutSeconds).toEqual(60);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(getConnection(group.resourceGroupName, connection.connectionName)),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), logLevel),
  { tags, timeout: 10_800_000 },
);
