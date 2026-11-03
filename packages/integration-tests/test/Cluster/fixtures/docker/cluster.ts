/** The local database and the pool every fixture entity runs on. */
import * as ClusterDocker from "@alchemy.run/effect-cluster/Docker";
import * as Layer from "effect/Layer";

export const FRONT_PORT = 18610;

export const Database = ClusterDocker.Database("Cluster");

export const Default = ClusterDocker.SwarmPool("Default", { replicas: 2 }).pipe(
  Layer.provide(Database),
);

/** A pool of its own for the external program. */
export const Legacy = ClusterDocker.SwarmPool("Legacy").pipe(Layer.provide(Database));
