import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPerimeter = (
  resourceGroupName: string,
  networkSecurityPerimeterName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkSecurityPerimeter({
      subscriptionId,
      resourceGroupName,
      networkSecurityPerimeterName,
    }),
  );

const getRule = (
  resourceGroupName: string,
  networkSecurityPerimeterName: string,
  profileName: string,
  accessRuleName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkSecurityPerimeterAccessRule({
      subscriptionId,
      resourceGroupName,
      networkSecurityPerimeterName,
      profileName,
      accessRuleName,
    }),
  );
const getProfile = (
  resourceGroupName: string,
  networkSecurityPerimeterName: string,
  profileName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkSecurityPerimeterProfile({
      subscriptionId,
      resourceGroupName,
      networkSecurityPerimeterName,
      profileName,
    }),
  );

// Network security perimeters are free.
const program = (prefixes: string[]) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const perimeter = yield* Azure.Network.NetworkSecurityPerimeter(
      "Perimeter",
      {
        resourceGroup: group.resourceGroupName,
      },
    );
    const profile = yield* Azure.Network.NetworkSecurityPerimeterProfile(
      "Default",
      {
        resourceGroup: group.resourceGroupName,
        networkSecurityPerimeter: perimeter.networkSecurityPerimeterName,
      },
    );
    const rule = yield* Azure.Network.NetworkSecurityPerimeterAccessRule(
      "Office",
      {
        resourceGroup: group.resourceGroupName,
        networkSecurityPerimeter: perimeter.networkSecurityPerimeterName,
        profile: profile.profileName,
        direction: "Inbound",
        addressPrefixes: prefixes,
      },
    );
    return { group, perimeter, profile, rule };
  });

test.provider(
  "create, update, and delete a perimeter profile (with an access rule)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, perimeter, profile, rule } = yield* stack.deploy(
        program(["203.0.113.0/24"]),
      );
      expect(rule.direction).toEqual("Inbound");
      expect(rule.addressPrefixes).toEqual(["203.0.113.0/24"]);

      const updated = yield* stack.deploy(
        program(["203.0.113.0/24", "198.51.100.0/24"]),
      );
      expect(updated.rule.accessRuleId).toEqual(rule.accessRuleId);
      const observed = yield* getRule(
        group.resourceGroupName,
        perimeter.networkSecurityPerimeterName,
        profile.profileName,
        rule.accessRuleName,
      );
      expect([...(observed.properties?.addressPrefixes ?? [])].sort()).toEqual([
        "198.51.100.0/24",
        "203.0.113.0/24",
      ]);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getProfile(
            group.resourceGroupName,
            perimeter.networkSecurityPerimeterName,
            profile.profileName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
