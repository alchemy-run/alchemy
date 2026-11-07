import * as GCP from "@alchemy.run/gcp";

/** DataCatalog resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeTaxonomy = GCP.DataCatalog.Taxonomy("ProbeTaxonomy", {
  location: "us-central1",
  description: "taxonomy a",
  activatedPolicyTypes: ["FINE_GRAINED_ACCESS_CONTROL"],
});
