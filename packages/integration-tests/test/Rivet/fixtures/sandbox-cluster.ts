/** The control plane and Rivet Services pool the agentOS Sandbox suite runs on. */
import * as RivetDocker from "@alchemy.run/rivet/Docker";
import * as Layer from "effect/Layer";

// Distinct from the other Rivet fixtures' ports: the suites run concurrently.
export const SANDBOX_CONTROL_PLANE_PORT = 16500;
export const SANDBOX_FRONT_PORT = 18500;

export const SandboxControlPlane = RivetDocker.SwarmControlPlane("RivetSandbox", {
  port: SANDBOX_CONTROL_PLANE_PORT,
});
// Rivet Services runs the prebuilt agentOS actor.
export const SandboxServices = RivetDocker.ServicesPool("SandboxServices").pipe(
  Layer.provide(SandboxControlPlane),
);
