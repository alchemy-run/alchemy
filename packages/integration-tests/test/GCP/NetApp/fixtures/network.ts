import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/**
 * NetApp volumes mount through Private Service Access to
 * `netapp.servicenetworking.goog`: a VPC network with a range peered to the
 * NetApp producer. The `default` network has none (volume create fails with
 * `Please create Service Networking connection with service
 * 'netapp.servicenetworking.goog'`), so suites that create volumes build
 * their own. Returns the network path their storage pools join.
 */
export const NetAppNetwork = Effect.gen(function* () {
  const network = yield* GCP.Compute.Network("NetAppVpc", {
    autoCreateSubnetworks: false,
  });
  const range = yield* GCP.Compute.GlobalAddress("NetAppPsaRange", {
    addressType: "INTERNAL",
    purpose: "VPC_PEERING",
    network: network.selfLink,
    prefixLength: 24,
  });
  const psa = yield* GCP.ServiceNetworking.Connection("NetAppPsa", {
    network: network.networkName,
    service: "netapp.servicenetworking.goog",
    reservedPeeringRanges: [range.addressName],
  });
  return psa.network;
});
