import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { deployProject } from "../../deployProject.ts";

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
/** A data clean room exchange: query templates live only in one. */
export const ProbeQueryTemplate = Effect.gen(function* () {
  const project = yield* deployProject;
  const exchange = yield* GCP.AnalyticsHub.DataExchange("ProbeCleanRoom", {
    location: "US",
    displayName: "Probe Clean Room",
    sharingEnvironmentConfig: { dcrExchangeConfig: {} },
  });
  return yield* GCP.AnalyticsHub.DataExchangesQueryTemplate("ProbeQueryTemplate", {
    dataExchange: exchange.name,
    location: "US",
    displayName: "Counts",
    primaryContact: `alchemy-testing@${project}.iam.gserviceaccount.com`,
    routine: { routineType: "TABLE_VALUED_FUNCTION", definitionBody: "SELECT 1 AS n" },
  });
});
