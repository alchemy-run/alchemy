import * as Azure from "@alchemy.run/azure";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (resourceGroupName: string, ddosCustomPolicyName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetDdosCustomPolicy({ subscriptionId, resourceGroupName, ddosCustomPolicyName }),
  );

// DDoS custom policies are free (no protection plan is attached).
const program = (props: { synPps: number; env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const policy = yield* Azure.Network.DdosCustomPolicy("Ddos", {
      resourceGroup: group.resourceGroupName,
      detectionRules: [{ name: "syn", trafficType: "TcpSyn", packetsPerSecond: props.synPps }],
      tags: { env: props.env },
    });
    return { group, policy };
  });

test.provider(
  "create, update, and delete a DDoS custom policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, policy } = yield* stack.deploy(program({ synPps: 10000, env: "test" }));
      expect(policy.detectionRuleNames).toEqual(["syn"]);
      const observed = yield* getPolicy(group.resourceGroupName, policy.ddosCustomPolicyName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties?.detectionRules?.[0]?.properties?.trafficDetectionRule
          ?.packetsPerSecond,
      ).toEqual(10000);
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(program({ synPps: 20000, env: "prod" }));
      expect(updated.policy.ddosCustomPolicyId).toEqual(policy.ddosCustomPolicyId);
      const reobserved = yield* getPolicy(group.resourceGroupName, policy.ddosCustomPolicyName);
      expect(
        reobserved.properties?.detectionRules?.[0]?.properties?.trafficDetectionRule
          ?.packetsPerSecond,
      ).toEqual(20000);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(getPolicy(group.resourceGroupName, policy.ddosCustomPolicyName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
