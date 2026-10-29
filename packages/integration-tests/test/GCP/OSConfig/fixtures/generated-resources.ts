import * as GCP from "@alchemy.run/gcp";

/** OSConfig resources the generated bindings bind, mirroring each resource suite's smallest shape. */
export const ProbeOrchestrator = GCP.OSConfig.ProjectsLocationsGlobalPolicyOrchestrator(
  "ProbeOrchestrator",
  { state: "STOPPED" },
);
