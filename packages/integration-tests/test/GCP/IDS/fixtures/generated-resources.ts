import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** An IDS endpoint on its own Private Service Access network, for the generated bindings to read. */
export const ProbeEndpoint = Effect.gen(function* () {
  const vpc = yield* GCP.Compute.Network("ProbeIdsVpc", { autoCreateSubnetworks: false });
  const range = yield* GCP.Compute.GlobalAddress("ProbeIdsPsaRange", {
    addressType: "INTERNAL",
    purpose: "VPC_PEERING",
    network: vpc.selfLink,
    prefixLength: 24,
  });
  const psa = yield* GCP.ServiceNetworking.Connection("ProbeIdsPsa", {
    network: vpc.networkName,
    service: "servicenetworking.googleapis.com",
    reservedPeeringRanges: [range.addressName],
  });
  return yield* GCP.IDS.Endpoint("ProbeEndpoint", {
    location: "us-central1-a",
    network: psa.network,
    severity: "MEDIUM",
  });
});
