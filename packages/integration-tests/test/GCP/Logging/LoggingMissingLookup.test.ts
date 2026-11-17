import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:logging", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-buckets-link": GCP.Logging.BucketsLink.lookup({ linkId: name, bucket: name }).name,
        "missing-buckets-view": GCP.Logging.BucketsView.lookup({ viewId: name, bucket: name }).name,
        "missing-folder-bucket": GCP.Logging.FolderBucket.lookup({ bucketId: name }).name,
        "missing-folder-buckets-link": GCP.Logging.FolderBucketsLink.lookup({
          linkId: name,
          bucketName: name,
        }).name,
        "missing-folder-buckets-view": GCP.Logging.FolderBucketsView.lookup({
          viewId: name,
          bucketName: name,
        }).name,
        "missing-folder-log-scope": GCP.Logging.FolderLogScope.lookup({ logScopeId: name }).name,
        "missing-folder-saved-query": GCP.Logging.FolderSavedQuery.lookup({ savedQueryId: name })
          .name,
        "missing-folder-sink": GCP.Logging.FolderSink.lookup({ sinkId: name }).name,
        "missing-locations-bucket": GCP.Logging.LocationsBucket.lookup({ bucketId: name }).name,
        "missing-locations-buckets-link": GCP.Logging.LocationsBucketsLink.lookup({
          linkId: name,
          bucketName: name,
        }).name,
        "missing-locations-buckets-view": GCP.Logging.LocationsBucketsView.lookup({
          viewId: name,
          bucketName: name,
        }).name,
        "missing-log-bucket": GCP.Logging.LogBucket.lookup({ bucketId: name }).name,
        "missing-log-scope": GCP.Logging.LogScope.lookup({ logScopeId: name }).name,
        "missing-metric": GCP.Logging.Metric.lookup({ metricId: name }).name,
        "missing-organization-buckets-link": GCP.Logging.OrganizationBucketsLink.lookup({
          linkId: name,
          bucket: name,
        }).name,
        "missing-saved-query": GCP.Logging.SavedQuery.lookup({ savedQueryId: name }).name,
        "missing-sink": GCP.Logging.Sink.lookup({ sinkId: name }).name,
      });
    }),
  { tags, timeout: 315000 },
);
