/** The database and the two-runner pool the Domain conformance model runs on. */
import * as ClusterDocker from "@alchemy.run/effect-cluster/Docker";
import * as Layer from "effect/Layer";

// Distinct from the Docker (18610) and Kubernetes (18620) fixtures: the suites
// run concurrently and each binds its port on the host.
export const DOMAIN_FRONT_PORT = 18630;

export const DomainDatabase = ClusterDocker.Database("ClusterDomain");

export const DomainPool = ClusterDocker.SwarmPool("DomainPool", { replicas: 2 }).pipe(
  Layer.provide(DomainDatabase),
);
