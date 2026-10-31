import * as GCP from "@alchemy.run/gcp";

/** Dataproc resources the generated bindings bind, beside the suite's own cluster. */
export { Jobs } from "./bindings-host.ts";

export const ProbeScaling = GCP.Dataproc.AutoscalingPolicy("ProbeScaling", {
  location: "us-central1",
  workerConfig: { minInstances: 2, maxInstances: 3 },
});
export const ProbeRegionScaling = GCP.Dataproc.RegionsAutoscalingPolicy("ProbeRegionScaling", {
  region: "us-central1",
  workerConfig: { minInstances: 2, maxInstances: 3 },
});
export const ProbeSessionTemplate = GCP.Dataproc.SessionTemplate("ProbeSessionTemplate", {
  location: "us-central1",
  jupyterSession: { kernel: "PYTHON" },
});
export const ProbeWorkflow = GCP.Dataproc.WorkflowTemplate("ProbeWorkflow", {
  location: "us-central1",
});
export const ProbeRegionWorkflow = GCP.Dataproc.RegionsWorkflowTemplate("ProbeRegionWorkflow", {
  region: "us-central1",
});
