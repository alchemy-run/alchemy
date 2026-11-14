/** The Hetzner suite's cluster: Postgres on a Server, runners on Servers behind a Load Balancer. */
import * as ClusterHetzner from "@alchemy.run/effect-cluster/Hetzner";
import * as Layer from "effect/Layer";

export const Database = ClusterHetzner.Database("Cluster");

export const Default = ClusterHetzner.ServerPool("Default", { replicas: 2 }).pipe(
  Layer.provide(Database),
);

/** A pool of its own for the external program. */
export const Legacy = ClusterHetzner.ServerPool("Legacy", { replicas: 1 }).pipe(
  Layer.provide(Database),
);
