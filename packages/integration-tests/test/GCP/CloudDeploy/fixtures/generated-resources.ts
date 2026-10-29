import * as GCP from "@alchemy.run/gcp";

/** CloudDeploy resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeCustomTargetType = GCP.CloudDeploy.CustomTargetType("ProbeCustomTargetType", {
  customActions: { deployAction: "helm-deploy" },
  description: "alchemy-test-custom-target",
});
