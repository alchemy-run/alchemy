import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dnsresolver from "@distilled.cloud/azure/dnsresolver";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { createVnet, deleteVnet, subscription, untilGone } from "./network.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The DNS resolver API rejects resource group names over 80 characters.
const groupOnly = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    name: "alchemy-test-dnsresolver-rule",
    location: "eastus",
  });
  return { group };
});

const withRule = (props: {
  vnetId: string;
  subnetId: string;
  domainName: string;
  targetDnsServers: Azure.DnsResolver.TargetDnsServer[];
  forwardingRuleState?: Azure.DnsResolver.ForwardingRuleState;
  metadata: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group } = yield* groupOnly;
    const resolver = yield* Azure.DnsResolver.DnsResolver("Resolver", {
      resourceGroup: group.resourceGroupName,
      virtualNetworkId: props.vnetId,
    });
    const outbound = yield* Azure.DnsResolver.OutboundEndpoint("Outbound", {
      resourceGroup: group.resourceGroupName,
      dnsResolver: resolver.dnsResolverName,
      subnetId: props.subnetId,
    });
    const ruleset = yield* Azure.DnsResolver.ForwardingRuleset("Ruleset", {
      resourceGroup: group.resourceGroupName,
      outboundEndpointIds: [outbound.outboundEndpointId],
    });
    const rule = yield* Azure.DnsResolver.ForwardingRule("Rule", {
      resourceGroup: group.resourceGroupName,
      dnsForwardingRuleset: ruleset.dnsForwardingRulesetName,
      domainName: props.domainName,
      targetDnsServers: props.targetDnsServers,
      forwardingRuleState: props.forwardingRuleState,
      metadata: props.metadata,
    });
    return { group, ruleset, rule };
  });

const getRule = (
  resourceGroupName: string,
  dnsForwardingRulesetName: string,
  forwardingRuleName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    dnsresolver.GetForwardingRule({
      subscriptionId,
      resourceGroupName,
      dnsForwardingRulesetName,
      forwardingRuleName,
    }),
  );

// Cost: one outbound endpoint (~$0.25/hour) for a few minutes plus a
// ruleset — well under $0.50. ~6-10 minutes.
test.provider(
  "create, update, replace, and delete a DNS forwarding rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(groupOnly);
      const rg = group.resourceGroupName;
      const vnet = yield* createVnet(rg, "hub", "10.80.0.0/16", [
        { name: "outbound", addressPrefix: "10.80.0.0/28" },
      ]);
      const base = { vnetId: vnet.vnetId, subnetId: vnet.subnetId("outbound") };

      // Create.
      const created = yield* stack.deploy(
        withRule({
          ...base,
          domainName: "contoso.internal.",
          targetDnsServers: [{ ipAddress: "10.0.0.4" }],
          metadata: { purpose: "test" },
        }),
      );
      const { ruleset, rule } = created;
      const rulesetName = ruleset.dnsForwardingRulesetName;
      expect(rule.domainName).toEqual("contoso.internal.");
      expect(rule.targetDnsServers).toEqual([
        { ipAddress: "10.0.0.4", port: 53 },
      ]);
      expect(rule.forwardingRuleState).toEqual("Enabled");
      expect(rule.metadata).toEqual({ purpose: "test" });
      const observed = yield* getRule(rg, rulesetName, rule.forwardingRuleName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.metadata?.["alchemy::id"]).toEqual("Rule");

      // In-place update: targets, state, and metadata.
      const updated = yield* stack.deploy(
        withRule({
          ...base,
          domainName: "contoso.internal.",
          targetDnsServers: [
            { ipAddress: "10.0.0.5" },
            { ipAddress: "10.0.0.6", port: 53 },
          ],
          forwardingRuleState: "Disabled",
          metadata: { purpose: "prod" },
        }),
      );
      expect(updated.rule.forwardingRuleName).toEqual(rule.forwardingRuleName);
      const reobserved = yield* getRule(
        rg,
        rulesetName,
        rule.forwardingRuleName,
      );
      expect(reobserved.properties.targetDnsServers).toEqual([
        { ipAddress: "10.0.0.5", port: 53 },
        { ipAddress: "10.0.0.6", port: 53 },
      ]);
      expect(reobserved.properties.forwardingRuleState).toEqual("Disabled");
      expect(reobserved.properties.metadata?.purpose).toEqual("prod");

      // Replacement: a different domain.
      const replaced = yield* stack.deploy(
        withRule({
          ...base,
          domainName: "fabrikam.internal.",
          targetDnsServers: [{ ipAddress: "10.0.0.5" }],
          metadata: { purpose: "prod" },
        }),
      );
      expect(replaced.rule.forwardingRuleName).not.toEqual(
        rule.forwardingRuleName,
      );
      const moved = yield* getRule(
        rg,
        rulesetName,
        replaced.rule.forwardingRuleName,
      );
      expect(moved.properties.domainName).toEqual("fabrikam.internal.");
      expect(
        yield* untilGone(getRule(rg, rulesetName, rule.forwardingRuleName)),
      ).toEqual("gone");

      // Delete.
      yield* stack.deploy(groupOnly);
      expect(
        yield* untilGone(
          getRule(rg, rulesetName, replaced.rule.forwardingRuleName),
        ),
      ).toEqual("gone");

      yield* deleteVnet(rg, "hub");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:dnsresolver", "live"],
    timeout: 600_000,
  },
);
