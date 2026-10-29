import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** Apim resources the generated bindings bind, mirroring each resource suite's smallest shape. */
export const ProbeObservationSource = Effect.gen(function* () {
  const subnet = yield* GCP.Compute.Subnetwork("ProbeApimSubnet", {
    network: "default",
    region: "us-central1",
    ipCidrRange: "172.20.112.0/24",
    privateIpGoogleAccess: true,
  });
  return yield* GCP.Apim.ObservationSource("ProbeObservationSource", {
    location: "us-central1",
    gclbObservationSource: {
      pscNetworkConfigs: [{ network: "default", subnetwork: subnet.subnetworkName }],
    },
  });
});
/** A job observes at least one source. */
export const ProbeObservationJob = Effect.gen(function* () {
  const source = yield* ProbeObservationSource;
  return yield* GCP.Apim.ObservationJob("ProbeObservationJob", {
    location: "us-central1",
    sources: [source.name],
    enabled: false,
  });
});
