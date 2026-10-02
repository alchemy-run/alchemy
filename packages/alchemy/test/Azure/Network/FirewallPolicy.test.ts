import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (resourceGroupName: string, firewallPolicyName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetFirewallPolicy({
      subscriptionId,
      resourceGroupName,
      firewallPolicyName,
    }),
  );

// A firewall policy without firewalls is free.
const program = (props: {
  threatIntelMode: "Alert" | "Deny";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const policy = yield* Azure.Network.FirewallPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
      threatIntelMode: props.threatIntelMode,
      tags: props.tags,
    });
    return { group, policy };
  });

test.provider(
  "create, update, and delete a firewall policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, policy } = yield* stack.deploy(
        program({ threatIntelMode: "Alert", tags: { env: "test" } }),
      );
      expect(policy.tier).toEqual("Standard");
      const observed = yield* getPolicy(
        group.resourceGroupName,
        policy.firewallPolicyName,
      );
      expect(observed.properties?.threatIntelMode).toEqual("Alert");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        program({ threatIntelMode: "Deny", tags: { env: "prod" } }),
      );
      expect(updated.policy.firewallPolicyId).toEqual(policy.firewallPolicyId);
      const reobserved = yield* getPolicy(
        group.resourceGroupName,
        policy.firewallPolicyName,
      );
      expect(reobserved.properties?.threatIntelMode).toEqual("Deny");
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPolicy(group.resourceGroupName, policy.firewallPolicyName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
