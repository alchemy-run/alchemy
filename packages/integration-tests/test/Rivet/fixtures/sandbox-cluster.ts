/** The control plane and Rivet Services pool the agentOS Sandbox suite runs on. */
import * as RivetDocker from "@alchemy.run/rivet/Docker";
import * as Layer from "effect/Layer";

// On a port Swarm picks: the suite runs beside the others and itself.
export const SandboxControlPlane = RivetDocker.SwarmControlPlane("RivetSandbox", { port: 0 });
// Rivet Services runs the prebuilt agentOS actor.
export const SandboxServices = RivetDocker.ServicesPool("SandboxServices").pipe(
  Layer.provide(SandboxControlPlane),
);
