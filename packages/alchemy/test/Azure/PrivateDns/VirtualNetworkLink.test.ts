import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as privatedns from "@distilled.cloud/azure/privatedns";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

// Both virtual networks stay deployed across every step so the link
// replacement never removes its old dependency in the same deploy.
const base = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const hub = yield* Azure.Network.VirtualNetwork("Hub", {
    resourceGroup: group.resourceGroupName,
    addressPrefixes: ["10.80.0.0/16"],
  });
  const spoke = yield* Azure.Network.VirtualNetwork("Spoke", {
    resourceGroup: group.resourceGroupName,
    addressPrefixes: ["10.81.0.0/16"],
  });
  const zone = yield* Azure.PrivateDns.Zone("Zone", {
    resourceGroup: group.resourceGroupName,
  });
  return { group, hub, spoke, zone };
});

const program = (props: {
  vnet: "hub" | "spoke";
  registrationEnabled?: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, hub, spoke, zone } = yield* base;
    const link = yield* Azure.PrivateDns.VirtualNetworkLink("Link", {
      resourceGroup: group.resourceGroupName,
      privateZoneName: zone.privateZoneName,
      virtualNetworkId:
        props.vnet === "hub" ? hub.virtualNetworkId : spoke.virtualNetworkId,
      registrationEnabled: props.registrationEnabled,
      tags: props.tags,
    });
    return { group, hub, spoke, zone, link };
  });

const getLink = (
  resourceGroupName: string,
  privateZoneName: string,
  virtualNetworkLinkName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    privatedns.GetVirtualNetworkLink({
      subscriptionId,
      resourceGroupName,
      privateZoneName,
      virtualNetworkLinkName,
    }),
  );

// Cost: links ~$0.10/month, zone $0.50/month, VNets free — fractions of a
// cent. ~3-5 minutes.
test.provider(
  "create, update, replace, and delete a private DNS virtual network link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const created = yield* stack.deploy(
        program({ vnet: "hub", tags: { env: "test" } }),
      );
      const { group, hub, spoke, zone, link } = created;
      const rg = group.resourceGroupName;
      const zoneName = zone.privateZoneName;
      expect(link.virtualNetworkId.toLowerCase()).toEqual(
        hub.virtualNetworkId.toLowerCase(),
      );
      expect(link.registrationEnabled).toEqual(false);
      expect(link.virtualNetworkLinkState).toEqual("Completed");
      const observed = yield* getLink(
        rg,
        zoneName,
        link.virtualNetworkLinkName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.location).toEqual("global");
      expect(observed.tags?.alchemy_id).toEqual("Link");
      expect(observed.tags?.env).toEqual("test");

      // In-place update: registration + tags.
      const updated = yield* stack.deploy(
        program({
          vnet: "hub",
          registrationEnabled: true,
          tags: { env: "prod" },
        }),
      );
      expect(updated.link.virtualNetworkLinkId).toEqual(
        link.virtualNetworkLinkId,
      );
      expect(updated.link.registrationEnabled).toEqual(true);
      const reobserved = yield* getLink(
        rg,
        zoneName,
        link.virtualNetworkLinkName,
      );
      expect(reobserved.properties?.registrationEnabled).toEqual(true);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: link a different virtual network.
      const replaced = yield* stack.deploy(
        program({ vnet: "spoke", tags: { env: "prod" } }),
      );
      expect(replaced.link.virtualNetworkLinkName).not.toEqual(
        link.virtualNetworkLinkName,
      );
      const moved = yield* getLink(
        rg,
        zoneName,
        replaced.link.virtualNetworkLinkName,
      );
      expect(moved.properties?.virtualNetwork?.id?.toLowerCase()).toEqual(
        spoke.virtualNetworkId.toLowerCase(),
      );
      expect(moved.properties?.registrationEnabled).toEqual(false);
      expect(
        yield* untilGone(getLink(rg, zoneName, link.virtualNetworkLinkName)),
      ).toEqual("gone");

      // Delete.
      yield* stack.deploy(base);
      expect(
        yield* untilGone(
          getLink(rg, zoneName, replaced.link.virtualNetworkLinkName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
