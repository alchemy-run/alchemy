import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (resourceGroupName: string, policyName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetWebApplicationFirewallPolicy({
      subscriptionId,
      resourceGroupName,
      policyName,
    }),
  );

// WAF policies are free until associated with a WAF_v2 gateway.
const program = (mode: "Detection" | "Prevention", env: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const waf = yield* Azure.Network.WebApplicationFirewallPolicy("Waf", {
      resourceGroup: group.resourceGroupName,
      policySettings: { state: "Enabled", mode },
      customRules: [
        {
          name: "blockbadip",
          priority: 10,
          ruleType: "MatchRule",
          action: "Block",
          matchConditions: [
            {
              matchVariables: [{ variableName: "RemoteAddr" }],
              operator: "IPMatch",
              matchValues: ["203.0.113.0/24"],
            },
          ],
        },
      ],
      tags: { env },
    });
    return { group, waf };
  });

test.provider(
  "create, update, and delete a WAF policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, waf } = yield* stack.deploy(program("Detection", "test"));
      expect(waf.mode).toEqual("Detection");
      expect(waf.customRuleNames).toEqual(["blockbadip"]);
      const observed = yield* getPolicy(
        group.resourceGroupName,
        waf.policyName,
      );
      expect(
        observed.properties?.managedRules.managedRuleSets[0]?.ruleSetType,
      ).toEqual("OWASP");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(program("Prevention", "prod"));
      expect(updated.waf.policyId).toEqual(waf.policyId);
      const reobserved = yield* getPolicy(
        group.resourceGroupName,
        waf.policyName,
      );
      expect(reobserved.properties?.policySettings?.mode).toEqual("Prevention");
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(getPolicy(group.resourceGroupName, waf.policyName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
