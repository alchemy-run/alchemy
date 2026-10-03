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
    name: "alchemy-test-dnsresolver-inbound",
    location: "eastus",
  });
  return { group };
});

const withEndpoint = (props: {
  vnetId: string;
  ipConfiguration: Azure.DnsResolver.InboundEndpointIpConfiguration;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group } = yield* groupOnly;
    const resolver = yield* Azure.DnsResolver.DnsResolver("Resolver", {
      resourceGroup: group.resourceGroupName,
      virtualNetworkId: props.vnetId,
    });
    const inbound = yield* Azure.DnsResolver.InboundEndpoint("Inbound", {
      resourceGroup: group.resourceGroupName,
      dnsResolver: resolver.dnsResolverName,
      ipConfigurations: [props.ipConfiguration],
      tags: props.tags,
    });
    return { group, resolver, inbound };
  });

const getEndpoint = (
  resourceGroupName: string,
  dnsResolverName: string,
  inboundEndpointName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    dnsresolver.GetInboundEndpoint({
      subscriptionId,
      resourceGroupName,
      dnsResolverName,
      inboundEndpointName,
    }),
  );

// Cost: an inbound endpoint bills ~$0.25/hour; this test runs two endpoint
// generations for a few minutes each (< $0.50 even if billed per started
// hour). ~6-10 minutes.
test.provider(
  "create, update tags, replace, and delete a DNS resolver inbound endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(groupOnly);
      const rg = group.resourceGroupName;
      const vnet = yield* createVnet(rg, "hub", "10.50.0.0/16", [
        { name: "inbound", addressPrefix: "10.50.0.0/28" },
      ]);
      const subnetId = vnet.subnetId("inbound");

      // Create with a dynamic IP.
      const created = yield* stack.deploy(
        withEndpoint({
          vnetId: vnet.vnetId,
          ipConfiguration: { subnetId },
          tags: { env: "test" },
        }),
      );
      const { resolver, inbound } = created;
      expect(inbound.privateIpAddresses).toHaveLength(1);
      expect(inbound.privateIpAddresses[0]).toMatch(/^10\.50\.0\.\d+$/);
      expect(inbound.tags).toEqual({ env: "test" });
      const observed = yield* getEndpoint(
        rg,
        resolver.dnsResolverName,
        inbound.inboundEndpointName,
      );
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties.ipConfigurations[0]?.subnet.id.toLowerCase(),
      ).toEqual(subnetId.toLowerCase());
      expect(observed.tags?.["alchemy::id"]).toEqual("Inbound");

      // In-place update: tags.
      const updated = yield* stack.deploy(
        withEndpoint({
          vnetId: vnet.vnetId,
          ipConfiguration: { subnetId },
          tags: { env: "prod" },
        }),
      );
      expect(updated.inbound.inboundEndpointName).toEqual(
        inbound.inboundEndpointName,
      );
      expect(
        (yield* getEndpoint(
          rg,
          resolver.dnsResolverName,
          inbound.inboundEndpointName,
        )).tags?.env,
      ).toEqual("prod");

      // Replacement: a static IP on the same subnet (delete-first).
      const replaced = yield* stack.deploy(
        withEndpoint({
          vnetId: vnet.vnetId,
          ipConfiguration: {
            subnetId,
            privateIpAllocationMethod: "Static",
            privateIpAddress: "10.50.0.10",
          },
          tags: { env: "prod" },
        }),
      );
      expect(replaced.inbound.inboundEndpointName).not.toEqual(
        inbound.inboundEndpointName,
      );
      expect(replaced.inbound.privateIpAddresses).toEqual(["10.50.0.10"]);
      const reobserved = yield* getEndpoint(
        rg,
        resolver.dnsResolverName,
        replaced.inbound.inboundEndpointName,
      );
      expect(
        reobserved.properties.ipConfigurations[0]?.privateIpAllocationMethod,
      ).toEqual("Static");
      expect(
        yield* untilGone(
          getEndpoint(
            rg,
            resolver.dnsResolverName,
            inbound.inboundEndpointName,
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
            replaced.inbound.inboundEndpointName,
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
