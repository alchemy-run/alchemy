import * as s3 from "@distilled.cloud/aws/s3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { BucketEncryption } from "./Bucket.ts";

class BucketEncryptionNotConverged extends Data.TaggedError(
  "BucketEncryptionNotConverged",
)<{ bucket: string }> {}

export const desiredEncryptionRule = (
  encryption?: BucketEncryption,
): s3.ServerSideEncryptionRule => {
  const algorithm = encryption?.sseAlgorithm ?? "AES256";
  const blocked = encryption?.blockedEncryptionTypes ?? ["SSE-C"];
  return {
    ApplyServerSideEncryptionByDefault: {
      SSEAlgorithm: algorithm,
      KMSMasterKeyID:
        algorithm === "AES256" ? undefined : encryption?.kmsMasterKeyId,
    },
    BucketKeyEnabled: encryption?.bucketKeyEnabled ?? false,
    BlockedEncryptionTypes: {
      EncryptionType: blocked.length ? [...new Set(blocked)] : ["NONE"],
    },
  };
};

export const encryptionFingerprint = (
  rule: s3.ServerSideEncryptionRule | undefined,
) => {
  const key = rule?.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID;
  return JSON.stringify({
    algorithm: rule?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? null,
    key: (Redacted.isRedacted(key) ? Redacted.value(key) : key) ?? null,
    bucketKey: rule?.BucketKeyEnabled ?? false,
    blocked: [
      ...new Set(
        rule?.BlockedEncryptionTypes?.EncryptionType?.filter(
          (type) => type !== "NONE",
        ) ?? [],
      ),
    ].sort(),
  });
};

export const readBucketEncryption = (bucket: string) =>
  s3
    .getBucketEncryption({ Bucket: bucket })
    .pipe(
      Effect.map(
        (result) => result.ServerSideEncryptionConfiguration?.Rules?.[0],
      ),
    );

export const syncEncryption = Effect.fn(function* (
  bucket: string,
  encryption?: BucketEncryption,
) {
  const desired = desiredEncryptionRule(encryption);
  const matches = (rule: s3.ServerSideEncryptionRule | undefined) =>
    encryptionFingerprint(rule) === encryptionFingerprint(desired);
  if (matches(yield* readBucketEncryption(bucket))) return false;
  yield* s3.putBucketEncryption({
    Bucket: bucket,
    ServerSideEncryptionConfiguration: { Rules: [desired] },
  });
  const observed = yield* readBucketEncryption(bucket).pipe(
    Effect.repeat({
      until: matches,
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );
  if (!matches(observed)) {
    return yield* Effect.fail(new BucketEncryptionNotConverged({ bucket }));
  }
  return true;
});
