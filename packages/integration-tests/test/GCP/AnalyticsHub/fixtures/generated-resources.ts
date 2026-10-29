import * as GCP from "@alchemy.run/gcp";

/** AnalyticsHub resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeDataExchange = GCP.AnalyticsHub.DataExchange("ProbeDataExchange", {
  location: "us-central1",
  displayName: "Marketplace",
  description: "shared datasets",
  primaryContact: "data@example.com",
});
