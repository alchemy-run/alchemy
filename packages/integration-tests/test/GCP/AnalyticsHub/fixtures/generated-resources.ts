import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** AnalyticsHub resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeDataExchange = GCP.AnalyticsHub.DataExchange("ProbeDataExchange", {
  location: "us-central1",
  displayName: "Marketplace",
  description: "shared datasets",
  primaryContact: "data@example.com",
});

export const ProbeListing = Effect.gen(function* () {
  const exchange = yield* ProbeDataExchange;
  const dataset = yield* GCP.BigQuery.Dataset("ProbeListingSource", {
    location: "US-CENTRAL1",
    forceDestroy: true,
  });
  return yield* GCP.AnalyticsHub.DataExchangesListing("ProbeListing", {
    dataExchange: exchange.name,
    location: "us-central1",
    displayName: "Probe",
    bigqueryDataset: { dataset: dataset.name },
  });
});
