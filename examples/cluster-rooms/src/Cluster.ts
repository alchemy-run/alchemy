import * as ClusterDocker from "@alchemy.run/cluster/Docker";
import * as Layer from "effect/Layer";

export const Database = ClusterDocker.Database("Cluster");

export const Default = ClusterDocker.Runners("Default", { replicas: 2 }).pipe(
  Layer.provide(Database),
);
