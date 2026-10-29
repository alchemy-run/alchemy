import * as GCP from "@alchemy.run/gcp";

/** BigLake resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeCatalog = GCP.BigLake.Catalog("ProbeCatalog", {
  location: "us-central1",
});
