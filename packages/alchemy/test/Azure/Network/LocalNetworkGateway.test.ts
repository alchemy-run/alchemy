import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGateway = (
  resourceGroupName: string,
  localNetworkGatewayName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetLocalNetworkGateway({
      subscriptionId,
      resourceGroupName,
      localNetworkGatewayName,
    }),
  );

// Local network gateways are free.
const program = (prefixes: string[], env: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const site = yield* Azure.Network.LocalNetworkGateway("Office", {
      resourceGroup: group.resourceGroupName,
      gatewayIpAddress: "203.0.113.10",
      addressPrefixes: prefixes,
      tags: { env },
    });
    return { group, site };
  });

test.provider(
  "create, update, and delete a local network gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, site } = yield* stack.deploy(
        program(["192.168.0.0/24"], "test"),
      );
      expect(site.gatewayIpAddress).toEqual("203.0.113.10");
      const observed = yield* getGateway(
        group.resourceGroupName,
        site.localNetworkGatewayName,
      );
      expect(
        observed.properties.localNetworkAddressSpace?.addressPrefixes,
      ).toEqual(["192.168.0.0/24"]);
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        program(["192.168.0.0/24", "192.168.1.0/24"], "prod"),
      );
      expect(updated.site.localNetworkGatewayId).toEqual(
        site.localNetworkGatewayId,
      );
      const reobserved = yield* getGateway(
        group.resourceGroupName,
        site.localNetworkGatewayName,
      );
      expect(
        [
          ...(reobserved.properties.localNetworkAddressSpace?.addressPrefixes ??
            []),
        ].sort(),
      ).toEqual(["192.168.0.0/24", "192.168.1.0/24"]);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getGateway(group.resourceGroupName, site.localNetworkGatewayName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
