import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** Logging resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeExclusion = GCP.Logging.Exclusion("ProbeExclusion", {
  filter: "severity=DEBUG",
  description: "drop debug entries",
});
export const ProbeFolderBucket = GCP.Logging.FolderBucket("ProbeFolderBucket", {
  description: "application logs",
  retentionDays: 31,
});
export const ProbeFolderSavedQuery = GCP.Logging.FolderSavedQuery("ProbeFolderSavedQuery", {
  displayName: "application errors",
  loggingQuery: { filter: "severity>=ERROR" },
  description: "error query",
});
export const ProbeLocationsBucket = GCP.Logging.LocationsBucket("ProbeLocationsBucket", {
  description: "application logs",
  retentionDays: 31,
});
export const ProbeLogBucket = GCP.Logging.LogBucket("ProbeLogBucket", {
  description: "application logs",
  retentionDays: 31,
});
export const ProbeMetric = GCP.Logging.Metric("ProbeMetric", {
  filter: "severity>=ERROR",
  description: "count errors",
});
export const ProbeSavedQuery = GCP.Logging.SavedQuery("ProbeSavedQuery", {
  displayName: "application errors",
  loggingQuery: { filter: "severity>=ERROR" },
  description: "error query",
});

export const ProbeView = Effect.gen(function* () {
  const bucket = yield* ProbeLogBucket;
  return yield* GCP.Logging.BucketsView("ProbeView", {
    bucket: bucket.name,
    filter: 'LOG_ID("stdout")',
  });
});
export const ProbeLocationsView = Effect.gen(function* () {
  const bucket = yield* ProbeLocationsBucket;
  return yield* GCP.Logging.LocationsBucketsView("ProbeLocationsView", {
    bucketName: bucket.name,
    filter: 'LOG_ID("stdout")',
  });
});
