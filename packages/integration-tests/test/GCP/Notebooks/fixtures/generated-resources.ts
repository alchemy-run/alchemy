import * as GCP from "@alchemy.run/gcp";

/** A small Workbench instance for the generated bindings to read and control. */
export const ProbeInstance = GCP.Notebooks.Instance("ProbeInstance", {
  location: "us-central1-a",
  machineType: "e2-standard-2",
});
