/** The database and the two-runner pool the Domain conformance model runs on. */
import * as ClusterDocker from "@alchemy.run/effect-cluster/Docker";
import * as Layer from "effect/Layer";

export const DomainDatabase = ClusterDocker.Database("ClusterDomain");

/** How many connections each of a runner's pools to the database holds at most. */
export const DOMAIN_DATABASE_CONNECTIONS = 4;

/** The pool's runners. */
export const DOMAIN_RUNNERS = 2;

export const DomainPool = ClusterDocker.SwarmPool("DomainPool", {
  replicas: DOMAIN_RUNNERS,
  databaseConnections: DOMAIN_DATABASE_CONNECTIONS,
}).pipe(Layer.provide(DomainDatabase));
