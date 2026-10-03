import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dnsresolver from "@distilled.cloud/azure/dnsresolver";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { subscription, untilGone } from "./network.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The DNS resolver API rejects resource group names over 80 characters.
const program = (props: {
  name?: string;
  priority: number;
  action: Azure.DnsResolver.SecurityRuleAction;
  lists: ReadonlyArray<"Blocked" | "Watched">;
  state?: "Enabled" | "Disabled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      name: "alchemy-test-dnsresolver-securityrule",
      location: "eastus",
    });
    const blocked = yield* Azure.DnsResolver.DomainList("Blocked", {
      resourceGroup: group.resourceGroupName,
      domains: ["malicious.contoso.com."],
    });
    const watched = yield* Azure.DnsResolver.DomainList("Watched", {
      resourceGroup: group.resourceGroupName,
      domains: ["suspicious.contoso.com."],
    });
    const policy = yield* Azure.DnsResolver.Policy("Policy", {
      resourceGroup: group.resourceGroupName,
    });
    const ids = { Blocked: blocked.domainListId, Watched: watched.domainListId };
    const rule = yield* Azure.DnsResolver.SecurityRule("Rule", {
      resourceGroup: group.resourceGroupName,
      dnsResolverPolicy: policy.policyName,
      name: props.name,
      priority: props.priority,
      action: props.action,
      domainListIds: props.lists.map((list) => ids[list]),
      state: props.state,
      tags: props.tags,
    });
    return { group, policy, blocked, watched, rule };
  });

const getRule = (
  resourceGroupName: string,
  dnsResolverPolicyName: string,
  dnsSecurityRuleName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    dnsresolver.GetDnsSecurityRule({
      subscriptionId,
      resourceGroupName,
      dnsResolverPolicyName,
      dnsSecurityRuleName,
    }),
  );

const listIds = (rule: dnsresolver.GetDnsSecurityRuleResponse) =>
  rule.properties.dnsResolverDomainLists.map((list) => list.id.toLowerCase());

// Cost: a DNS security policy with no virtual network links, its rules,
// and domain lists are free. ~3 min.
test.provider(
  "create, update, replace, and delete a DNS security rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const created = yield* stack.deploy(
        program({
          priority: 100,
          action: "Block",
          lists: ["Blocked"],
          tags: { env: "test" },
        }),
      );
      const { group, policy, blocked, watched, rule } = created;
      const rg = group.resourceGroupName;
      const policyName = policy.policyName;
      expect(rule.priority).toEqual(100);
      expect(rule.action).toEqual("Block");
      expect(rule.state).toEqual("Enabled");
      expect(rule.tags).toEqual({ env: "test" });
      const observed = yield* getRule(rg, policyName, rule.securityRuleName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.priority).toEqual(100);
      expect(observed.properties.action.actionType).toEqual("Block");
      expect(listIds(observed)).toEqual([blocked.domainListId.toLowerCase()]);
      expect(observed.tags?.["alchemy::id"]).toEqual("Rule");

      // In-place update: priority, action, domain lists, state, and tags.
      const updated = yield* stack.deploy(
        program({
          priority: 200,
          action: "Alert",
          lists: ["Blocked", "Watched"],
          state: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(updated.rule.securityRuleName).toEqual(rule.securityRuleName);
      expect(updated.rule.securityRuleId).toEqual(rule.securityRuleId);
      const reobserved = yield* getRule(rg, policyName, rule.securityRuleName);
      expect(reobserved.properties.priority).toEqual(200);
      expect(reobserved.properties.action.actionType).toEqual("Alert");
      expect(reobserved.properties.dnsSecurityRuleState).toEqual("Disabled");
      expect(listIds(reobserved).sort()).toEqual(
        [
          blocked.domainListId.toLowerCase(),
          watched.domainListId.toLowerCase(),
        ].sort(),
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-test-securityrule-renamed",
          priority: 200,
          action: "Allow",
          lists: ["Watched"],
          tags: { env: "prod" },
        }),
      );
      expect(replaced.rule.securityRuleName).toEqual(
        "alchemy-test-securityrule-renamed",
      );
      const renamed = yield* getRule(
        rg,
        policyName,
        "alchemy-test-securityrule-renamed",
      );
      expect(renamed.properties.action.actionType).toEqual("Allow");
      expect(listIds(renamed)).toEqual([watched.domainListId.toLowerCase()]);
      expect(
        yield* untilGone(getRule(rg, policyName, rule.securityRuleName)),
      ).toEqual("gone");

      // Delete.
      yield* stack.destroy();
      expect(
        yield* untilGone(
          getRule(rg, policyName, "alchemy-test-securityrule-renamed"),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:dnsresolver", "live"],
    timeout: 600_000,
  },
);
