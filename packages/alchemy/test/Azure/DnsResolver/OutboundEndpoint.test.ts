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
    name: "alchemy-test-dnsresolver-outbound",
    location: "eastus",
  });
  return { group };
});

const withEndpoint = (props: {
  vnetId: string;
  subnetId: string;
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
      tags: props.tags,
    });
    return { group, resolver, outbound };
  });

const getEndpoint = (
  resourceGroupName: string,
  dnsResolverName: string,
  outboundEndpointName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    dnsresolver.GetOutboundEndpoint({
      subscriptionId,
      resourceGroupName,
      dnsResolverName,
      outboundEndpointName,
    }),
  );

// Cost: an outbound endpoint bills ~$0.25/hour; this test runs two endpoint
// generations for a few minutes each (< $0.50 even if billed per started
// hour). ~6-10 minutes.
test.provider(
  "create, update tags, replace, and delete a DNS resolver outbound endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(groupOnly);
      const rg = group.resourceGroupName;
      const vnet = yield* createVnet(rg, "hub", "10.60.0.0/16", [
        { name: "outbound-a", addressPrefix: "10.60.0.0/28" },
        { name: "outbound-b", addressPrefix: "10.60.0.16/28" },
      ]);
      const subnetA = vnet.subnetId("outbound-a");
      const subnetB = vnet.subnetId("outbound-b");

      // Create.
      const created = yield* stack.deploy(
        withEndpoint({
          vnetId: vnet.vnetId,
          subnetId: subnetA,
          tags: { env: "test" },
        }),
      );
      const { resolver, outbound } = created;
      expect(outbound.subnetId.toLowerCase()).toEqual(subnetA.toLowerCase());
      expect(outbound.tags).toEqual({ env: "test" });
      const observed = yield* getEndpoint(
        rg,
        resolver.dnsResolverName,
        outbound.outboundEndpointName,
      );
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.["alchemy::id"]).toEqual("Outbound");

      // In-place update: tags.
      const updated = yield* stack.deploy(
        withEndpoint({
          vnetId: vnet.vnetId,
          subnetId: subnetA,
          tags: { env: "prod" },
        }),
      );
      expect(updated.outbound.outboundEndpointName).toEqual(
        outbound.outboundEndpointName,
      );
      expect(
        (yield* getEndpoint(
          rg,
          resolver.dnsResolverName,
          outbound.outboundEndpointName,
        )).tags?.env,
      ).toEqual("prod");

      // Replacement: another subnet.
      const replaced = yield* stack.deploy(
        withEndpoint({
          vnetId: vnet.vnetId,
          subnetId: subnetB,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.outbound.outboundEndpointName).not.toEqual(
        outbound.outboundEndpointName,
      );
      const reobserved = yield* getEndpoint(
        rg,
        resolver.dnsResolverName,
        replaced.outbound.outboundEndpointName,
      );
      expect(reobserved.properties.subnet.id.toLowerCase()).toEqual(
        subnetB.toLowerCase(),
      );
      expect(
        yield* untilGone(
          getEndpoint(
            rg,
            resolver.dnsResolverName,
            outbound.outboundEndpointName,
          ),
        ),
      ).toEqual("gone");

      // Delete.
      yield* stack.deploy(groupOnly);
      expect(
        yield* untilGone(
          getEndpoint(
            rg,
            resolver.dnsResolverName,
            replaced.outbound.outboundEndpointName,
          ),
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
