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

// The DNS resolver API rejects resource group names over 80 characters, and
// the engine-generated name for this file is longer.
const groupOnly = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    name: "alchemy-test-dnsresolver-resolver",
    location: "eastus",
  });
  return { group };
});

const withResolver = (virtualNetworkId: string, tags: Record<string, string>) =>
  Effect.gen(function* () {
    const { group } = yield* groupOnly;
    const resolver = yield* Azure.DnsResolver.DnsResolver("Resolver", {
      resourceGroup: group.resourceGroupName,
      virtualNetworkId,
      tags,
    });
    return { group, resolver };
  });

const getResolver = (resourceGroupName: string, dnsResolverName: string) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    dnsresolver.GetDnsResolver({
      subscriptionId,
      resourceGroupName,
      dnsResolverName,
    }),
  );

// Cost: the resolver itself is free and the virtual networks are free.
// ~3-6 minutes.
test.provider(
  "create, update tags, replace, and delete a DNS resolver",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(groupOnly);
      const rg = group.resourceGroupName;
      const hub = yield* createVnet(rg, "hub", "10.40.0.0/16");
      const spoke = yield* createVnet(rg, "spoke", "10.41.0.0/16");

      // Create.
      const created = yield* stack.deploy(
        withResolver(hub.vnetId, { env: "test" }),
      );
      const resolver = created.resolver;
      expect(resolver.dnsResolverName).toMatch(
        /^[A-Za-z0-9][\w-]{0,78}[A-Za-z0-9]$/,
      );
      expect(resolver.virtualNetworkId.toLowerCase()).toEqual(
        hub.vnetId.toLowerCase(),
      );
      expect(resolver.tags).toEqual({ env: "test" });
      const observed = yield* getResolver(rg, resolver.dnsResolverName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.virtualNetwork.id.toLowerCase()).toEqual(
        hub.vnetId.toLowerCase(),
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Resolver");

      // In-place update: tags.
      const updated = yield* stack.deploy(
        withResolver(hub.vnetId, { env: "prod" }),
      );
      expect(updated.resolver.dnsResolverName).toEqual(
        resolver.dnsResolverName,
      );
      const reobserved = yield* getResolver(rg, resolver.dnsResolverName);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: a different virtual network.
      const replaced = yield* stack.deploy(
        withResolver(spoke.vnetId, { env: "prod" }),
      );
      expect(replaced.resolver.dnsResolverName).not.toEqual(
        resolver.dnsResolverName,
      );
      const moved = yield* getResolver(rg, replaced.resolver.dnsResolverName);
      expect(moved.properties.virtualNetwork.id.toLowerCase()).toEqual(
        spoke.vnetId.toLowerCase(),
      );
      expect(
        yield* untilGone(getResolver(rg, resolver.dnsResolverName)),
      ).toEqual("gone");

      // Delete.
      yield* stack.deploy(groupOnly);
      expect(
        yield* untilGone(getResolver(rg, replaced.resolver.dnsResolverName)),
      ).toEqual("gone");

      yield* deleteVnet(rg, "hub");
      yield* deleteVnet(rg, "spoke");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:dnsresolver", "live"],
    timeout: 600_000,
  },
);
