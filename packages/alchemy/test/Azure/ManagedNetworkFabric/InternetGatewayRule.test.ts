import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

type Props = Omit<
  Azure.ManagedNetworkFabric.InternetGatewayRuleProps,
  "resourceGroup"
>;

const program = (props: Props) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const res = yield* Azure.ManagedNetworkFabric.InternetGatewayRule(
      "InternetGatewayRule",
      {
        resourceGroup: group.resourceGroupName,
        ...props,
      },
    );
    return { group, res };
  });

const get = (resourceGroupName: string, internetGatewayRuleName: string) =>
  Effect.gen(function* () {
    return yield* mnf.GetInternetGatewayRule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      internetGatewayRuleName,
    });
  });

const CREATE: Props = {
  ruleProperties: { action: "Allow", addressList: ["10.0.0.1"] },
  tags: { env: "a" },
};

const UPDATE: Props = {
  ruleProperties: { action: "Allow", addressList: ["10.0.0.1"] },
  tags: { env: "b" },
};

// ARM configuration object only (no fabric attached): $0, ~1-3 minutes.
test.provider(
  "create, update, replace, and delete an internet gateway rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(program(CREATE));
      const observed = yield* get(
        group.resourceGroupName,
        res.internetGatewayRuleName,
      );
      expect(observed.properties.ruleProperties.addressList).toEqual([
        "10.0.0.1",
      ]);
      expect(observed.tags?.env).toEqual("a");
      expect(observed.tags?.["alchemy::id"]).toEqual("InternetGatewayRule");
      expect(res.provisioningState).toEqual("Succeeded");

      // In place.
      const updated = yield* stack.deploy(program(UPDATE));
      expect(updated.res.internetGatewayRuleId).toEqual(
        res.internetGatewayRuleId,
      );
      const reobserved = yield* get(
        group.resourceGroupName,
        res.internetGatewayRuleName,
      );
      expect(reobserved.properties.ruleProperties.addressList).toEqual([
        "10.0.0.1",
      ]);
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement.
      const replaced = yield* stack.deploy(
        program({
          ...UPDATE,
          ruleProperties: { action: "Deny", addressList: ["10.1.0.1"] },
        }),
      );
      expect(replaced.res.internetGatewayRuleId).not.toEqual(
        res.internetGatewayRuleId,
      );
      expect(
        (yield* get(
          group.resourceGroupName,
          replaced.res.internetGatewayRuleName,
        )).properties.ruleProperties.action,
      ).toEqual("Deny");
      expect(
        yield* waitGone(
          get(group.resourceGroupName, res.internetGatewayRuleName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(group.resourceGroupName, replaced.res.internetGatewayRuleName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
