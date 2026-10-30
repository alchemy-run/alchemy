import * as GCP from "@alchemy.run/gcp";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { deployProject } from "../../deployProject.ts";

/** Config resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeDeploymentGroup = GCP.Config.DeploymentGroup("ProbeDeploymentGroup", {
  deploymentUnits: [{ id: "network", dependencies: [] }],
});

/** A Terraform preview, run as its own service account holding the Infra Manager agent role. */
export const ProbePreview = Effect.gen(function* () {
  const project = yield* deployProject;
  const runner = yield* GCP.IAM.ServiceAccount("ProbePreviewRunner", {
    displayName: "infra manager probe runner",
  });
  yield* GCP.IAM.Member("ProbePreviewRunnerAgent", {
    kind: "project",
    name: project,
    role: "roles/config.agent",
    member: Output.interpolate`serviceAccount:${runner.email}`,
  });
  return yield* GCP.Config.Preview("ProbePreview", {
    serviceAccount: runner.name,
    terraformBlueprint: {
      gitSource: {
        repo: "https://github.com/terraform-google-modules/terraform-docs-samples.git",
        directory: "storage/quickstart",
      },
    },
  });
});
