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
    frequencyOptions: {
      frequency: "DAILY",
      startDate: { year: 2090, month: 1, day: 1 },
      endDate: { year: 2091, month: 1, day: 1 },
    },
    csvOptions: { delimiter: ",", headerRequired: true },
    objectMetadataReportOptions: {
      metadataFields: ["project", "bucket", "name"],
      storageFilters: { bucket: source.bucketName },
      storageDestinationOptions: { bucket: reports.bucketName },
    },
  });
});
