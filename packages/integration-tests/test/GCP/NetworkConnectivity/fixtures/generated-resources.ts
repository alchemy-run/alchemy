import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as Effect from "effect/Effect";
import { defaultNetworkSelfLink } from "../../networkQuota.ts";

/** NetworkConnectivity resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeHub = GCP.NetworkConnectivity.Hub("ProbeHub", {
  description: "ncc hub a",
});
export const ProbeMulticloudDataTransferConfig =
  GCP.NetworkConnectivity.MulticloudDataTransferConfig("ProbeMulticloudDataTransferConfig", {
    location: "europe-west1",
    description: "dte a",
    services: { "cloud-storage": {}, "compute-engine": {} },
  });

export const ProbeInternalRange = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  return yield* GCP.NetworkConnectivity.InternalRange("ProbeInternalRange", {
    network: defaultNetworkSelfLink(project),
    usage: "FOR_VPC",
    peering: "FOR_SELF",
    ipCidrRange: "172.20.99.0/24",
  });
});
export const ProbePolicyRoute = GCP.NetworkConnectivity.PolicyBasedRoute("ProbePolicyRoute", {
  network: "default",
  filter: {
    protocolVersion: "IPV4",
    ipProtocol: "TCP",
    srcRange: "10.0.0.0/8",
    destRange: "192.0.2.0/24",
  },
  nextHopOtherRoutes: "DEFAULT_ROUTING",
  virtualMachine: { tags: ["alchemy-probe-pbr"] },
});
