/** The Fly suite's cluster: Postgres on a Fly Machine, runners on a Fly Service. */
import * as ClusterFly from "@alchemy.run/cluster/Fly";
import * as Layer from "effect/Layer";

export const Database = ClusterFly.Database("Cluster");

export const Default = ClusterFly.Runners("Default", { replicas: 2 }).pipe(Layer.provide(Database));

/** Runners of their own for the external program. */
export const Legacy = ClusterFly.Runners("Legacy", { replicas: 1 }).pipe(Layer.provide(Database));
