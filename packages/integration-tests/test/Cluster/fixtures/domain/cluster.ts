/** The database and the two-runner pool the Domain conformance model runs on. */
import * as ClusterDocker from "@alchemy.run/effect-cluster/Docker";
import * as Layer from "effect/Layer";

export const DOMAIN_FRONT_PORT = 18620;

export const DomainDatabase = ClusterDocker.Database("ClusterDomain");

export const DomainPool = ClusterDocker.SwarmPool("DomainPool", { replicas: 2 }).pipe(
  Layer.provide(DomainDatabase),
);
