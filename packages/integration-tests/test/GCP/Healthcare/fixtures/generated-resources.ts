import * as GCP from "@alchemy.run/gcp";

/** Healthcare resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeDataset = GCP.Healthcare.Dataset("ProbeDataset", {
  location: "us-central1",
  timeZone: "America/New_York",
});
