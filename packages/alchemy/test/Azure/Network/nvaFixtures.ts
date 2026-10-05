import * as Azure from "@/Azure";
import * as Effect from "effect/Effect";
import { standardHub } from "./wanFixtures.ts";

/**
 * Standard hub + Barracuda SD-WAN NVA. Needs marketplace terms accepted and
 * a paid subscription (the free trial blocks marketplace offers); the hub
 * alone bills ~$0.25/hour and the NVA deployment takes 30+ minutes.
 */
export const hubNva = Effect.gen(function* () {
  const { group, wan, hub } = yield* standardHub;
  const nva = yield* Azure.Network.NetworkVirtualAppliance("Nva", {
    resourceGroup: group.resourceGroupName,
    virtualHubId: hub.virtualHubId,
    nvaSku: {
      vendor: "barracudasdwanrelease",
      bundledScaleUnit: "2",
      marketPlaceVersion: "latest",
    },
    virtualApplianceAsn: 64512,
  });
  return { group, wan, hub, nva };
});
