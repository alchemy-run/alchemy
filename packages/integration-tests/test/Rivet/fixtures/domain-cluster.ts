/** The control plane and pool the Domain conformance model runs on. */
import * as RivetDocker from "@alchemy.run/rivet/Docker";
import * as Layer from "effect/Layer";

// Distinct from the Kubernetes fixture's ports (16450, 18450): both suites run concurrently.
export const DOMAIN_CONTROL_PLANE_PORT = 16470;
export const DOMAIN_FRONT_PORT = 18470;

export const DomainControlPlane = RivetDocker.SwarmControlPlane("RivetDomain", {
  port: DOMAIN_CONTROL_PLANE_PORT,
});
export const DomainPool = RivetDocker.SwarmPool("DomainPool").pipe(
  Layer.provide(DomainControlPlane),
);
