import * as GCP from "@alchemy.run/gcp";

/** DataLineage resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeProcess = GCP.DataLineage.Process("ProbeProcess", {
  location: "us-central1",
  displayName: "etl a",
  origin: { sourceType: "CUSTOM", name: "alchemy" },
  attributes: { env: "test" },
});
