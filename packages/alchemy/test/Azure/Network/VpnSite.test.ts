import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSite = (resourceGroupName: string, vpnSiteName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVpnSite({ subscriptionId, resourceGroupName, vpnSiteName }),
  );

// VPN sites and the virtual WAN object are free and provision in seconds.
const program = (props: { addressPrefixes: string[]; env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const wan = yield* Azure.Network.VirtualWan("Wan", {
      resourceGroup: group.resourceGroupName,
    });
    const site = yield* Azure.Network.VpnSite("Branch", {
      resourceGroup: group.resourceGroupName,
      virtualWanId: wan.virtualWanId,
      addressPrefixes: props.addressPrefixes,
      deviceVendor: "Contoso",
      links: [
        {
          name: "isp1",
          ipAddress: "203.0.113.10",
          providerName: "ISP One",
          speedInMbps: 100,
        },
      ],
      tags: { env: props.env },
    });
    return { group, wan, site };
  });

test.provider(
  "create, update, and delete a VPN site",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, wan, site } = yield* stack.deploy(
        program({ addressPrefixes: ["10.20.0.0/16"], env: "test" }),
      );
      expect(site.linkNames).toEqual(["isp1"]);
      const observed = yield* getSite(group.resourceGroupName, site.vpnSiteName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.virtualWan?.id?.toLowerCase()).toEqual(
        wan.virtualWanId.toLowerCase(),
      );
      expect(
        observed.properties?.vpnSiteLinks?.[0]?.properties?.ipAddress,
      ).toEqual("203.0.113.10");

      const updated = yield* stack.deploy(
        program({
          addressPrefixes: ["10.20.0.0/16", "10.21.0.0/16"],
          env: "prod",
        }),
      );
      expect(updated.site.vpnSiteId).toEqual(site.vpnSiteId);
      const reobserved = yield* getSite(
        group.resourceGroupName,
        site.vpnSiteName,
      );
      expect(
        [...(reobserved.properties?.addressSpace?.addressPrefixes ?? [])].sort(),
      ).toEqual(["10.20.0.0/16", "10.21.0.0/16"]);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(getSite(group.resourceGroupName, site.vpnSiteName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
