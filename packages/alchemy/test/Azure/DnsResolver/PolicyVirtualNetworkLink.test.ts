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
const withPolicy = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    name: "alchemy-test-dnsresolver-policylink",
    location: "eastus",
  });
  const policy = yield* Azure.DnsResolver.Policy("Policy", {
    resourceGroup: group.resourceGroupName,
  });
  return { group, policy };
});

const withLink = (props: {
  virtualNetworkId: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, policy } = yield* withPolicy;
    const link = yield* Azure.DnsResolver.PolicyVirtualNetworkLink("Link", {
      resourceGroup: group.resourceGroupName,
      dnsResolverPolicy: policy.policyName,
      virtualNetworkId: props.virtualNetworkId,
      tags: props.tags,
    });
    return { group, policy, link };
  });

const getLink = (
  resourceGroupName: string,
  dnsResolverPolicyName: string,
  dnsResolverPolicyVirtualNetworkLinkName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    dnsresolver.GetDnsResolverPolicyVirtualNetworkLink({
      subscriptionId,
      resourceGroupName,
      dnsResolverPolicyName,
      dnsResolverPolicyVirtualNetworkLinkName,
    }),
  );

// Cost: DNS security policies bill per linked virtual network-hour (a few
// cents for minutes); policies and virtual networks are free. ~3-5 min.
test.provider(
  "create, update tags, replace, and delete a DNS security policy virtual network link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, policy } = yield* stack.deploy(withPolicy);
      const rg = group.resourceGroupName;
      const policyName = policy.policyName;
      const first = yield* createVnet(rg, "first", "10.92.0.0/16");
      const second = yield* createVnet(rg, "second", "10.93.0.0/16");

      // Create.
      const { link } = yield* stack.deploy(
        withLink({ virtualNetworkId: first.vnetId, tags: { env: "test" } }),
      );
      expect(link.virtualNetworkId.toLowerCase()).toEqual(
        first.vnetId.toLowerCase(),
      );
      expect(link.tags).toEqual({ env: "test" });
      const observed = yield* getLink(
        rg,
        policyName,
        link.virtualNetworkLinkName,
      );
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Link");

      // In-place update: tags.
      const updated = yield* stack.deploy(
        withLink({ virtualNetworkId: first.vnetId, tags: { env: "prod" } }),
      );
      expect(updated.link.virtualNetworkLinkName).toEqual(
        link.virtualNetworkLinkName,
      );
      expect(
        (yield* getLink(rg, policyName, link.virtualNetworkLinkName)).tags
          ?.env,
      ).toEqual("prod");

      // Replacement: link a different virtual network.
      const replaced = yield* stack.deploy(
        withLink({ virtualNetworkId: second.vnetId, tags: { env: "prod" } }),
      );
      expect(replaced.link.virtualNetworkLinkName).not.toEqual(
        link.virtualNetworkLinkName,
      );
      const moved = yield* getLink(
        rg,
        policyName,
        replaced.link.virtualNetworkLinkName,
      );
      expect(moved.properties.virtualNetwork.id.toLowerCase()).toEqual(
        second.vnetId.toLowerCase(),
      );
      expect(
        yield* untilGone(getLink(rg, policyName, link.virtualNetworkLinkName)),
      ).toEqual("gone");

      // Delete.
      yield* stack.deploy(withPolicy);
      expect(
        yield* untilGone(
          getLink(rg, policyName, replaced.link.virtualNetworkLinkName),
        ),
      ).toEqual("gone");

      yield* deleteVnet(rg, "second");
      yield* deleteVnet(rg, "first");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:dnsresolver", "live"],
    timeout: 600_000,
  },
);
