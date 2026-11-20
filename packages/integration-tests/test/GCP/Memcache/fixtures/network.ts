import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/**
 * Memcached instances reach their nodes through Private Service Access: a
 * VPC network with a range peered to Google's service producer. The suite
 * builds its own, since the `default` network has none (create fails with
 * `PrivateServiceAccessNotEnabled`). Returns the network path the instance
 * authorizes.
 */
export const CacheNetwork = Effect.gen(function* () {
  const network = yield* GCP.Compute.Network("CacheVpc", {
    autoCreateSubnetworks: false,
  });
  const range = yield* GCP.Compute.GlobalAddress("CachePsaRange", {
    addressType: "INTERNAL",
    purpose: "VPC_PEERING",
    network: network.selfLink,
    prefixLength: 24,
  });
  const psa = yield* GCP.ServiceNetworking.Connection("CachePsa", {
    network: network.networkName,
    reservedPeeringRanges: [range.addressName],
  });
  return psa.network;
});
