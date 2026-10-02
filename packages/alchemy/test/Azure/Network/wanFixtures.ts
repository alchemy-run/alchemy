import * as Azure from "@/Azure";
import * as Effect from "effect/Effect";

/**
 * Resource group + Standard virtual WAN + Standard hub (eastus). The hub
 * bills ~$0.25/hour and takes 15-30 minutes to provision its router, so
 * every test built on it is gated behind AZURE_TEST_EXPENSIVE=1.
 */
export const standardHub = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const wan = yield* Azure.Network.VirtualWan("Wan", {
    resourceGroup: group.resourceGroupName,
  });
  const hub = yield* Azure.Network.VirtualHub("Hub", {
    resourceGroup: group.resourceGroupName,
    virtualWanId: wan.virtualWanId,
    addressPrefix: "10.100.0.0/23",
  });
  return { group, wan, hub };
});

/** A spoke VNet in the hub's resource group. */
export const spokeVnet = (resourceGroup: string, addressPrefix: string) =>
  Azure.Network.VirtualNetwork("Spoke", {
    resourceGroup,
    location: "eastus",
    addressPrefixes: [addressPrefix],
  });
