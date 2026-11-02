/** The Hetzner suite's cluster: Postgres on a Server, runners on Servers behind a Load Balancer. */
import * as ClusterHetzner from "@alchemy.run/effect-cluster/Hetzner";
import * as Layer from "effect/Layer";

export const Database = ClusterHetzner.Database("Cluster");

export const Default = ClusterHetzner.Runners("Default", { replicas: 2 }).pipe(
  Layer.provide(Database),
);

/** Runners of their own for the external program. */
export const Legacy = ClusterHetzner.Runners("Legacy", { replicas: 1 }).pipe(
  Layer.provide(Database),
);
