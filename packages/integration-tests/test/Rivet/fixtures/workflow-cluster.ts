/** The control plane and pool the Workflows conformance suite runs on. */
import * as RivetDocker from "@alchemy.run/rivet/Docker";
import * as Layer from "effect/Layer";

// Distinct from the other Rivet fixtures' ports: the suites run concurrently.
export const WORKFLOW_CONTROL_PLANE_PORT = 16490;
export const WORKFLOW_FRONT_PORT = 18490;

export const WorkflowControlPlane = RivetDocker.SwarmControlPlane("RivetWorkflows", {
  port: WORKFLOW_CONTROL_PLANE_PORT,
});
export const WorkflowPool = RivetDocker.SwarmPool("WorkflowPool").pipe(
  Layer.provide(WorkflowControlPlane),
);
