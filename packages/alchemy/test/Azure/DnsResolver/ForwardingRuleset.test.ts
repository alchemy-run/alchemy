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
    name: "alchemy-test-dnsresolver-ruleset",
    location: "eastus",
  });
  return { group };
});

const withRuleset = (props: {
  vnetId: string;
  subnetId: string;
  name?: string;
  tags: Record<string, string>;
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
      name: props.name,
      outboundEndpointIds: [outbound.outboundEndpointId],
      tags: props.tags,
    });
    return { group, resolver, outbound, ruleset };
  });

const getRuleset = (
  resourceGroupName: string,
  dnsForwardingRulesetName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    dnsresolver.GetDnsForwardingRuleset({
      subscriptionId,
      resourceGroupName,
      dnsForwardingRulesetName,
    }),
  );

// Cost: one outbound endpoint (~$0.25/hour) for a few minutes plus a
// ruleset (~$2.50/month) — well under $0.50. ~6-10 minutes.
test.provider(
  "create, update tags, replace, and delete a DNS forwarding ruleset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(groupOnly);
      const rg = group.resourceGroupName;
      const vnet = yield* createVnet(rg, "hub", "10.70.0.0/16", [
        { name: "outbound", addressPrefix: "10.70.0.0/28" },
      ]);
      const base = { vnetId: vnet.vnetId, subnetId: vnet.subnetId("outbound") };

      // Create.
      const created = yield* stack.deploy(
        withRuleset({ ...base, tags: { env: "test" } }),
      );
      const { outbound, ruleset } = created;
      expect(ruleset.outboundEndpointIds.map((id) => id.toLowerCase())).toEqual(
        [outbound.outboundEndpointId.toLowerCase()],
      );
      expect(ruleset.tags).toEqual({ env: "test" });
      const observed = yield* getRuleset(rg, ruleset.dnsForwardingRulesetName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties.dnsResolverOutboundEndpoints[0]?.id.toLowerCase(),
      ).toEqual(outbound.outboundEndpointId.toLowerCase());
      expect(observed.tags?.["alchemy::id"]).toEqual("Ruleset");

      // In-place update: tags.
      const updated = yield* stack.deploy(
        withRuleset({ ...base, tags: { env: "prod" } }),
      );
      expect(updated.ruleset.dnsForwardingRulesetName).toEqual(
        ruleset.dnsForwardingRulesetName,
      );
      expect(
        (yield* getRuleset(rg, ruleset.dnsForwardingRulesetName)).tags?.env,
      ).toEqual("prod");

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        withRuleset({
          ...base,
          name: "alchemy-test-ruleset-renamed",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.ruleset.dnsForwardingRulesetName).toEqual(
        "alchemy-test-ruleset-renamed",
      );
      expect(
        (yield* getRuleset(rg, "alchemy-test-ruleset-renamed")).tags?.env,
      ).toEqual("prod");
      expect(
        yield* untilGone(getRuleset(rg, ruleset.dnsForwardingRulesetName)),
      ).toEqual("gone");

      // Delete.
      yield* stack.deploy(groupOnly);
      expect(
        yield* untilGone(getRuleset(rg, "alchemy-test-ruleset-renamed")),
      ).toEqual("gone");

      yield* deleteVnet(rg, "hub");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:dnsresolver", "live"],
    timeout: 600_000,
  },
);
