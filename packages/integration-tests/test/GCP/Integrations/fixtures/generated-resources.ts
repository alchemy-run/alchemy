import * as GCP from "@alchemy.run/gcp";

/** Integrations resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeTemplate = GCP.Integrations.Template("ProbeTemplate", {
  location: "us-central1",
  displayName: "order-sync",
  description: "sync orders",
  tags: ["orders"],
  categories: ["SALES_AND_MARKETING"],
  visibility: "PRIVATE",
});
