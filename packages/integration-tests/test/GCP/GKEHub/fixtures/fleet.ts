import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { CAPACITY_ZONE } from "../../zones.ts";

/** The smallest GKE cluster: one spot e2-medium node (about 10 minutes to create). */
export const FleetCluster = GCP.Container.Cluster("FleetCluster", {
  location: CAPACITY_ZONE,
  machineType: "e2-medium",
  initialNodeCount: 1,
  diskSizeGb: 20,
  spot: true,
});

/** {@link FleetCluster} registered with the project's fleet. */
export const fleetMembership = (labels: Record<string, string>) =>
  Effect.gen(function* () {
    const cluster = yield* FleetCluster;
    return yield* GCP.GKEHub.Membership("Fleet", { cluster: cluster.name, labels });
  });
