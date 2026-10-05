import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

type Props = Omit<
  Azure.ManagedNetworkFabric.NetworkTapRuleProps,
  "resourceGroup"
>;

const program = (props: Props) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const res = yield* Azure.ManagedNetworkFabric.NetworkTapRule(
      "NetworkTapRule",
      {
        resourceGroup: group.resourceGroupName,
        ...props,
      },
    );
    return { group, res };
  });

const get = (resourceGroupName: string, networkTapRuleName: string) =>
  Effect.gen(function* () {
    return yield* mnf.GetNetworkTapRule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      networkTapRuleName,
    });
  });

const CREATE: Props = {
  configurationType: "Inline",
  matchConfigurations: [
    {
      matchConfigurationName: "tcp",
      sequenceNumber: 10,
      ipAddressType: "IPv4",
      matchConditions: [{ protocolTypes: ["TCP"] }],
      actions: [{ type: "Count" }],
    },
  ],
  tags: { env: "a" },
};

const UPDATE: Props = {
  configurationType: "Inline",
  matchConfigurations: [
    {
      matchConfigurationName: "tcp",
      sequenceNumber: 10,
      ipAddressType: "IPv4",
      matchConditions: [{ protocolTypes: ["TCP"] }],
      actions: [{ type: "Count" }],
    },
    {
      matchConfigurationName: "udp",
      sequenceNumber: 20,
      ipAddressType: "IPv4",
      matchConditions: [{ protocolTypes: ["UDP"] }],
      actions: [{ type: "Count" }],
    },
  ],
  tags: { env: "b" },
};

// ARM configuration object only (no fabric attached): $0, ~1-3 minutes.
test.provider(
  "create, update, replace, and delete a network tap rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(program(CREATE));
      const observed = yield* get(
        group.resourceGroupName,
        res.networkTapRuleName,
      );
      expect(observed.properties.matchConfigurations?.length).toEqual(1);
      expect(observed.tags?.env).toEqual("a");
      expect(observed.tags?.["alchemy::id"]).toEqual("NetworkTapRule");
      expect(res.provisioningState).toEqual("Succeeded");

      // In place.
      const updated = yield* stack.deploy(program(UPDATE));
      expect(updated.res.networkTapRuleId).toEqual(res.networkTapRuleId);
      const reobserved = yield* get(
        group.resourceGroupName,
        res.networkTapRuleName,
      );
      expect(
        reobserved.properties.matchConfigurations?.map(
          (m) => m.matchConfigurationName,
        ),
      ).toEqual(["tcp", "udp"]);
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement.
      const replaced = yield* stack.deploy(
        program({ ...UPDATE, location: "westus3" }),
      );
      expect(replaced.res.networkTapRuleId).not.toEqual(res.networkTapRuleId);
      expect(replaced.res.location).toEqual("westus3");
      expect(
        yield* waitGone(get(group.resourceGroupName, res.networkTapRuleName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(group.resourceGroupName, replaced.res.networkTapRuleName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
