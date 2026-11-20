import * as GCP from "@alchemy.run/gcp";

/** A developer Data Fusion instance for the generated bindings to read. */
export const ProbeInstance = GCP.DataFusion.Instance("ProbeInstance", {
  location: "us-central1",
  type: "DEVELOPER",
});
