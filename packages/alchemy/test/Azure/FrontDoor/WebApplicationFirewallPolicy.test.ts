import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as frontdoor from "@distilled.cloud/azure/frontdoor";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (resourceGroupName: string, policyName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* frontdoor.GetPolicy({
      subscriptionId,
      resourceGroupName,
      policyName,
    });
  });

const policyGone = (resourceGroupName: string, policyName: string) =>
  getPolicy(resourceGroupName, policyName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["NotFound", "ResourceNotFound", "ResourceGroupNotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const blockTestNet: Azure.FrontDoor.WebApplicationFirewallCustomRule = {
  name: "BlockTestNet",
  priority: 100,
  ruleType: "MatchRule",
  action: "Block",
  matchConditions: [
    {
      matchVariable: "RemoteAddr",
      operator: "IPMatch",
      matchValue: ["192.0.2.0/24"],
    },
  ],
};

const rateLimit: Azure.FrontDoor.WebApplicationFirewallCustomRule = {
  name: "RateLimitApi",
  priority: 200,
  ruleType: "RateLimitRule",
  rateLimitDurationInMinutes: 1,
  rateLimitThreshold: 500,
  groupBy: [{ variableName: "SocketAddr" }],
  action: "Block",
  matchConditions: [
    {
      matchVariable: "RequestUri",
      operator: "Contains",
      matchValue: ["/api"],
    },
  ],
};

const program = (
  props: Omit<Azure.FrontDoor.WebApplicationFirewallPolicyProps, "resourceGroup">,
) =>
  Effect.gen(function* () {
    // Front Door WAF rejects resource group names longer than 80
    // characters; the engine default for this stack exceeds that.
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      name: "alchemy-test-frontdoor-waf",
      location: "eastus",
    });
    const policy = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("Waf", {
      resourceGroup: group.resourceGroupName,
      ...props,
    });
    return { group, policy };
  });

// A standalone Standard WAF policy bills ~$5/month + $1/custom rule/month
// prorated hourly: a few minutes cost well under $0.01. Provisions in ~1 min.
test.provider(
  "create, update, replace, and delete a front door waf policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          policySettings: { enabledState: "Enabled", mode: "Detection" },
          customRules: [blockTestNet],
          tags: { env: "test" },
        }),
      );
      const rg = created.group.resourceGroupName;
      const policy = created.policy;
      expect(policy.policyName).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
      expect(policy.sku).toEqual("Standard_AzureFrontDoor");
      expect(policy.mode).toEqual("Detection");
      expect(policy.tags).toEqual({ env: "test" });
      const observed = yield* getPolicy(rg, policy.policyName);
      expect(observed.properties?.policySettings?.mode).toEqual("Detection");
      expect(
        observed.properties?.customRules?.rules?.map((r) => r.name),
      ).toEqual(["BlockTestNet"]);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Waf");

      // In place: Prevention mode, add a rate-limit rule, retag.
      const updated = yield* stack.deploy(
        program({
          policySettings: { enabledState: "Enabled", mode: "Prevention" },
          customRules: [blockTestNet, rateLimit],
          tags: { env: "prod" },
        }),
      );
      expect(updated.policy.policyId).toEqual(policy.policyId);
      expect(updated.policy.mode).toEqual("Prevention");
      const reobserved = yield* getPolicy(rg, policy.policyName);
      expect(reobserved.properties?.policySettings?.mode).toEqual(
        "Prevention",
      );
      const rules = reobserved.properties?.customRules?.rules ?? [];
      expect(rules.map((r) => r.name)).toEqual([
        "BlockTestNet",
        "RateLimitApi",
      ]);
      expect(rules[1]?.rateLimitThreshold).toEqual(500);
      expect(reobserved.tags?.env).toEqual("prod");

      // Changing the SKU replaces the policy (Premium + managed rule set).
      const replaced = yield* stack.deploy(
        program({
          sku: "Premium_AzureFrontDoor",
          policySettings: { enabledState: "Enabled", mode: "Prevention" },
          managedRules: {
            managedRuleSets: [
              {
                ruleSetType: "Microsoft_DefaultRuleSet",
                ruleSetVersion: "2.1",
                ruleSetAction: "Block",
              },
            ],
          },
          tags: { env: "prod" },
        }),
      );
      expect(replaced.policy.sku).toEqual("Premium_AzureFrontDoor");
      expect(replaced.policy.policyName).not.toEqual(policy.policyName);
      expect(yield* policyGone(rg, policy.policyName)).toEqual("gone");
      const fresh = yield* getPolicy(rg, replaced.policy.policyName);
      expect(fresh.sku?.name).toEqual("Premium_AzureFrontDoor");
      expect(
        fresh.properties?.managedRules?.managedRuleSets?.[0]?.ruleSetType,
      ).toEqual("Microsoft_DefaultRuleSet");
      expect(fresh.properties?.customRules?.rules ?? []).toEqual([]);

      yield* stack.destroy();
      expect(yield* policyGone(rg, replaced.policy.policyName)).toEqual(
        "gone",
      );
    }),
  {
    tags: ["provider:azure", "provider:azure:frontdoor", "live"],
    timeout: 900_000,
  },
);
