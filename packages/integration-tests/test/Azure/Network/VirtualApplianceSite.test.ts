import * as Azure from "@alchemy.run/azure";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";
import { hubNva } from "./nvaFixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSite = (
  resourceGroupName: string,
  networkVirtualApplianceName: string,
  siteName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVirtualApplianceSite({
      subscriptionId,
      resourceGroupName,
      networkVirtualApplianceName,
      siteName,
    }),
  );

const program = (optimize: boolean) =>
  Effect.gen(function* () {
    const { group, nva } = yield* hubNva;
    const site = yield* Azure.Network.VirtualApplianceSite("Branch", {
      resourceGroup: group.resourceGroupName,
      networkVirtualAppliance: nva.networkVirtualApplianceName,
      addressPrefix: "192.168.50.0/24",
      office365Breakout: { optimize },
    });
    return { group, nva, site };
  });

// ~$1+/run, 60+ min: a Standard hub (~$0.25/hour) plus a marketplace
// SD-WAN NVA (30+ minutes, vendor licence, marketplace terms). No cheap
// ungated probe exists: the parent appliance itself needs the hub and a
// paid marketplace offer (see NetworkVirtualAppliance.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete an NVA branch site",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, nva, site } = yield* stack.deploy(program(false));
      expect(site.addressPrefix).toEqual("192.168.50.0/24");
      const observed = yield* getSite(
        group.resourceGroupName,
        nva.networkVirtualApplianceName,
        site.siteName,
      );
      expect(observed.properties?.o365Policy?.breakOutCategories?.optimize).toEqual(false);

      const updated = yield* stack.deploy(program(true));
      expect(updated.site.siteId).toEqual(site.siteId);
      const reobserved = yield* getSite(
        group.resourceGroupName,
        nva.networkVirtualApplianceName,
        site.siteName,
      );
      expect(reobserved.properties?.o365Policy?.breakOutCategories?.optimize).toEqual(true);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getSite(group.resourceGroupName, nva.networkVirtualApplianceName, site.siteName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 10_800_000 },
);
