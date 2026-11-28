/** The control plane and pool the hosting suite runs on. */
import * as RivetDocker from "@alchemy.run/rivet/Docker";
import * as Layer from "effect/Layer";

// On a free port, so the suite runs beside itself and other suites.
export const HostedControlPlane = RivetDocker.SwarmControlPlane("RivetHosted", { port: 0 });
export const HostedPool = RivetDocker.SwarmPool("HostedPool").pipe(
  Layer.provide(HostedControlPlane),
);
