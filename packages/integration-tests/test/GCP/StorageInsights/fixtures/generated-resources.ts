import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** A daily inventory of one bucket into another, for the generated bindings to read. */
export const ProbeReportConfig = Effect.gen(function* () {
  const source = yield* GCP.Storage.Bucket("ProbeInventorySource", {
    location: "US-CENTRAL1",
    forceDestroy: true,
  });
  const reports = yield* GCP.Storage.Bucket("ProbeInventoryReports", {
    location: "US-CENTRAL1",
    forceDestroy: true,
  });
  return yield* GCP.StorageInsights.ReportConfig("ProbeReportConfig", {
    location: "us-central1",
    sourceBucket: source.bucketName,
    destinationBucket: reports.bucketName,
    startDate: "2027-01-01",
    endDate: "2027-12-31",
  });
});
