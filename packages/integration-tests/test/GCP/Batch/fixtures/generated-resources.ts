import * as GCP from "@alchemy.run/gcp";

/** A one-task job the generated Batch bindings read and cancel. */
export const ProbeJob = GCP.Batch.Job("ProbeJob", {
  location: "us-central1",
  taskGroups: [
    {
      taskSpec: {
        runnables: [{ script: { text: "echo alchemy probe" } }],
        computeResource: { cpuMilli: "500", memoryMib: "256" },
        maxRunDuration: "300s",
      },
    },
  ],
  allocationPolicy: { instances: [{ policy: { machineType: "e2-small" } }] },
  logsPolicy: { destination: "CLOUD_LOGGING" },
});
