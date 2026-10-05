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
    name: "alchemy-test-dnsresolver-rulesetlink",
    location: "eastus",
  });
  return { group };
});

const withLink = (props: {
  hubId: string;
  subnetId: string;
  linkedVnetId: string;
  metadata: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group } = yield* groupOnly;
    const resolver = yield* Azure.DnsResolver.DnsResolver("Resolver", {
      resourceGroup: group.resourceGroupName,
      virtualNetworkId: props.hubId,
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
    const link = yield* Azure.DnsResolver.ForwardingRulesetVirtualNetworkLink(
      "Link",
      {
        resourceGroup: group.resourceGroupName,
        dnsForwardingRuleset: ruleset.dnsForwardingRulesetName,
        virtualNetworkId: props.linkedVnetId,
        metadata: props.metadata,
      },
    );
    return { group, ruleset, link };
  });

const getLink = (
  resourceGroupName: string,
  dnsForwardingRulesetName: string,
  virtualNetworkLinkName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    dnsresolver.GetVirtualNetworkLink({
      subscriptionId,
      resourceGroupName,
      dnsForwardingRulesetName,
      virtualNetworkLinkName,
    }),
  );

// Cost: one outbound endpoint (~$0.25/hour) for a few minutes plus a
// ruleset; links and virtual networks are free — well under $0.50.
// ~6-10 minutes.
test.provider(
  "create, update metadata, replace, and delete a forwarding ruleset virtual network link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(groupOnly);
      const rg = group.resourceGroupName;
      const hub = yield* createVnet(rg, "hub", "10.90.0.0/16", [
        { name: "outbound", addressPrefix: "10.90.0.0/28" },
      ]);
      const spoke = yield* createVnet(rg, "spoke", "10.91.0.0/16");
      const base = { hubId: hub.vnetId, subnetId: hub.subnetId("outbound") };

      // Create.
      const created = yield* stack.deploy(
        withLink({
          ...base,
          linkedVnetId: hub.vnetId,
          metadata: { purpose: "test" },
        }),
      );
      const { ruleset, link } = created;
      const rulesetName = ruleset.dnsForwardingRulesetName;
      expect(link.virtualNetworkId.toLowerCase()).toEqual(
        hub.vnetId.toLowerCase(),
      );
      expect(link.metadata).toEqual({ purpose: "test" });
      const observed = yield* getLink(
        rg,
        rulesetName,
        link.virtualNetworkLinkName,
      );
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.metadata?.["alchemy::id"]).toEqual("Link");

      // In-place update: metadata.
      const updated = yield* stack.deploy(
        withLink({
          ...base,
          linkedVnetId: hub.vnetId,
          metadata: { purpose: "prod" },
        }),
      );
      expect(updated.link.virtualNetworkLinkName).toEqual(
        link.virtualNetworkLinkName,
      );
      expect(
        (yield* getLink(rg, rulesetName, link.virtualNetworkLinkName))
          .properties.metadata?.purpose,
      ).toEqual("prod");

      // Replacement: link a different virtual network.
      const replaced = yield* stack.deploy(
        withLink({
          ...base,
          linkedVnetId: spoke.vnetId,
          metadata: { purpose: "prod" },
        }),
      );
      expect(replaced.link.virtualNetworkLinkName).not.toEqual(
        link.virtualNetworkLinkName,
      );
      const moved = yield* getLink(
        rg,
        rulesetName,
        replaced.link.virtualNetworkLinkName,
      );
      expect(moved.properties.virtualNetwork.id.toLowerCase()).toEqual(
        spoke.vnetId.toLowerCase(),
      );
      expect(
        yield* untilGone(getLink(rg, rulesetName, link.virtualNetworkLinkName)),
      ).toEqual("gone");

      // Delete.
      yield* stack.deploy(groupOnly);
      expect(
        yield* untilGone(
          getLink(rg, rulesetName, replaced.link.virtualNetworkLinkName),
        ),
      ).toEqual("gone");

      yield* deleteVnet(rg, "spoke");
      yield* deleteVnet(rg, "hub");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:dnsresolver", "live"],
    timeout: 600_000,
  },
);
