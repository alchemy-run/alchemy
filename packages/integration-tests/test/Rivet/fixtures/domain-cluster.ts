/** The control plane and pool the Domain conformance model runs on. */
import * as RivetDocker from "@alchemy.run/rivet/Docker";
import * as Layer from "effect/Layer";

export const DOMAIN_CONTROL_PLANE_PORT = 16450;
export const DOMAIN_FRONT_PORT = 18450;

export const DomainControlPlane = RivetDocker.SwarmControlPlane("RivetDomain", {
  port: DOMAIN_CONTROL_PLANE_PORT,
});
export const DomainPool = RivetDocker.SwarmPool("DomainPool").pipe(
  Layer.provide(DomainControlPlane),
);
