import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getNsg = (resourceGroupName: string, networkSecurityGroupName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkSecurityGroup({
      subscriptionId,
      resourceGroupName,
      networkSecurityGroupName,
    }),
  );

const program = (props: {
  flushConnection: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const nsg = yield* Azure.Network.NetworkSecurityGroup("Web", {
      resourceGroup: group.resourceGroupName,
      flushConnection: props.flushConnection,
      tags: props.tags,
    });
    return { group, nsg };
  });

test.provider(
  "create, update, and delete a network security group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, nsg } = yield* stack.deploy(
        program({ flushConnection: false, tags: { env: "test" } }),
      );
      expect(nsg.flushConnection).toEqual(false);
      const observed = yield* getNsg(
        group.resourceGroupName,
        nsg.networkSecurityGroupName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(
        (observed.properties?.defaultSecurityRules ?? []).length,
      ).toBeGreaterThan(0);

      // In-place tag update (PATCH). `flushConnection: true` is not yet
      // enabled in eastus ("Network Security Group Connection Flushing is
      // not enabled yet for eastus region"), so it is not exercised here.
      const updated = yield* stack.deploy(
        program({ flushConnection: false, tags: { env: "prod", tier: "web" } }),
      );
      expect(updated.nsg.networkSecurityGroupId).toEqual(
        nsg.networkSecurityGroupId,
      );
      expect(updated.nsg.tags).toEqual({ env: "prod", tier: "web" });
      const reobserved = yield* getNsg(
        group.resourceGroupName,
        nsg.networkSecurityGroupName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.tags?.tier).toEqual("web");
      expect(reobserved.properties?.resourceGuid).toEqual(
        observed.properties?.resourceGuid,
      );

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getNsg(group.resourceGroupName, nsg.networkSecurityGroupName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
