import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { CAPACITY_REGION } from "../../zones.ts";

/** A workstation cluster, config and workstation for the generated Workstations bindings. */
export const ProbeCluster = GCP.Workstations.WorkstationCluster("ProbeCluster", {
  location: CAPACITY_REGION,
  network: "default",
  subnetwork: "default",
});
export const ProbeConfig = Effect.gen(function* () {
  const cluster = yield* ProbeCluster;
  return yield* GCP.Workstations.WorkstationClustersWorkstationConfig("ProbeConfig", {
    workstationCluster: cluster.name,
    host: { gceInstance: { machineType: "e2-standard-2", poolSize: 0, bootDiskSizeGb: 30 } },
  });
});
export const ProbeWorkstation = Effect.gen(function* () {
  const config = yield* ProbeConfig;
  return yield* GCP.Workstations.WorkstationClustersWorkstationConfigsWorkstation(
    "ProbeWorkstation",
    { workstationConfig: config.name },
  );
});
