/** The database and the two-runner pool the hosting suite runs on. */
import * as ClusterDocker from "@alchemy.run/effect-cluster/Docker";
import * as Layer from "effect/Layer";

export const HostedDatabase = ClusterDocker.Database("ClusterHosted");

export const HostedPool = ClusterDocker.SwarmPool("HostedPool", { replicas: 2 }).pipe(
  Layer.provide(HostedDatabase),
);
