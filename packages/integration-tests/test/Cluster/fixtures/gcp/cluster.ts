/** The GCP suite's cluster: Postgres and runners on Compute Engine. */
import * as ClusterGCP from "@alchemy.run/effect-cluster/GCP";
import * as Layer from "effect/Layer";

export const Database = ClusterGCP.Database("Cluster");

export const Default = ClusterGCP.ComputeEnginePool("Default", { replicas: 2 }).pipe(
  Layer.provide(Database),
);

/** A pool of its own for the external program. */
export const Legacy = ClusterGCP.ComputeEnginePool("Legacy", { replicas: 1 }).pipe(
  Layer.provide(Database),
);
