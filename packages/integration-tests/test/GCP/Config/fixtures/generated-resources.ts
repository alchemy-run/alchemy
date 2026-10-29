import * as GCP from "@alchemy.run/gcp";

/** Config resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeDeploymentGroup = GCP.Config.DeploymentGroup("ProbeDeploymentGroup", {
  deploymentUnits: [{ id: "network", dependencies: [] }],
});
