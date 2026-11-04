import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** A dry-run metadata job over an empty bucket, for the generated bindings to read. */
export const ProbeJob = Effect.gen(function* () {
  const bucket = yield* GCP.Storage.Bucket("ProbeBatchBucket", {
    location: "US-CENTRAL1",
    forceDestroy: true,
  });
  return yield* GCP.StorageBatchOperations.Job("ProbeJob", {
    bucket: { bucket: bucket.bucketName, includedObjectPrefixes: [""] },
    putMetadata: { cacheControl: "no-store" },
    dryRun: true,
  });
});
