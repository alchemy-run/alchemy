/** The control plane and pool the Workflows conformance suite runs on. */
import * as RivetDocker from "@alchemy.run/rivet/Docker";
import * as Layer from "effect/Layer";

// On a free port, so the suite runs beside itself and other suites.
export const WorkflowControlPlane = RivetDocker.SwarmControlPlane("RivetWorkflows", { port: 0 });
export const WorkflowPool = RivetDocker.SwarmPool("WorkflowPool").pipe(
  Layer.provide(WorkflowControlPlane),
);
