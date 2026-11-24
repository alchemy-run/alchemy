/** The control plane and pool the Domain conformance model runs on. */
import * as RivetDocker from "@alchemy.run/rivet/Docker";
import * as Layer from "effect/Layer";

// On a free port, so the suite runs beside itself and other suites.
export const DomainControlPlane = RivetDocker.SwarmControlPlane("RivetDomain", { port: 0 });
export const DomainPool = RivetDocker.SwarmPool("DomainPool").pipe(
  Layer.provide(DomainControlPlane),
);
