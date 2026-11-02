import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as s3 from "@distilled.cloud/aws/s3";
import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { s3Propagation, withOutOfBandS3 } from "./s3.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("objectstorage", "bucket"), timeout: 300_000 } as const;

/** Out-of-band: the bucket as STACKIT reports it, or `undefined` when gone. */
const observeBucket = (projectId: string, region: string, bucketName: string) =>
  objectStorage.getBucket({ projectId, region, bucketName }).pipe(
    Effect.map((response) => response.bucket),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** Typed, bounded wait until GET reports the bucket gone. */
const waitUntilBucketGone = (projectId: string, region: string, bucketName: string) =>
  observeBucket(projectId, region, bucketName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (bucket) => bucket === undefined,
      times: 10,
    }),
  );

const observeRetention = (projectId: string, region: string, bucketName: string) =>
  objectStorage.getDefaultRetention({ projectId, region, bucketName }).pipe(
    Effect.map((retention) => ({ mode: retention.mode, days: retention.days })),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

test.provider(
  "create, redeploy unchanged, and delete a bucket",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const bucket = yield* stack.deploy(Stackit.ObjectStorage.Bucket("Assets", {}));

      expect(bucket.projectId).toEqual(projectId);
      expect(bucket.region).toEqual(region);
      expect(bucket.objectLockEnabled).toEqual(false);
      expect(bucket.defaultRetention).toBeUndefined();
      expect(bucket.bucketName).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
      expect(bucket.urlPathStyle).toContain(bucket.bucketName);
      expect(bucket.urlVirtualHostedStyle).toContain(bucket.bucketName);

      const observed = yield* observeBucket(projectId, region, bucket.bucketName);
      expect(observed?.name).toEqual(bucket.bucketName);
      expect(observed?.objectLockEnabled).toEqual(false);
      expect(observed?.urlPathStyle).toEqual(bucket.urlPathStyle);

      const plan = yield* stack.plan(Stackit.ObjectStorage.Bucket("Assets", {}));
      expect(plan.resources.Assets).toMatchObject({ action: "noop" });

      // `list` (nuke) enumerates buckets with generated names.
      const provider = yield* Provider.findProvider(Stackit.ObjectStorage.Bucket);
      const listed = yield* provider.list();
      expect(listed.map((entry) => entry.bucketName)).toContain(bucket.bucketName);

      yield* stack.destroy();

      expect(yield* waitUntilBucketGone(projectId, region, bucket.bucketName)).toBeUndefined();
    }).pipe(logLevel),
  options,
);

test.provider(
  "renaming a bucket replaces it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(Stackit.ObjectStorage.Bucket("Renamed", {}));
      // Deterministic per stack/stage: derived from the generated name.
      const bucketName = `${first.bucketName.slice(0, 59)}-ren`;

      const plan = yield* stack.plan(Stackit.ObjectStorage.Bucket("Renamed", { bucketName }));
      expect(plan.resources.Renamed).toMatchObject({ action: "replace" });

      const second = yield* stack.deploy(Stackit.ObjectStorage.Bucket("Renamed", { bucketName }));
      expect(second.bucketName).toEqual(bucketName);
      expect((yield* observeBucket(projectId, region, bucketName))?.name).toEqual(bucketName);
      expect(yield* waitUntilBucketGone(projectId, region, first.bucketName)).toBeUndefined();

      yield* stack.destroy();

      expect(yield* waitUntilBucketGone(projectId, region, bucketName)).toBeUndefined();
    }).pipe(logLevel),
  options,
);

test.provider(
  "object lock bucket: set, update, and remove the default retention",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const archive = (defaultRetention?: Stackit.ObjectStorage.BucketDefaultRetention) =>
        Effect.gen(function* () {
          const lock = yield* Stackit.ObjectStorage.ComplianceLock("Lock", {});
          return yield* Stackit.ObjectStorage.Bucket("Archive", {
            // Orders the bucket after the lock, and deletes it first.
            projectId: lock.projectId,
            objectLockEnabled: true,
            defaultRetention,
          });
        });

      const created = yield* stack.deploy(archive({ mode: "GOVERNANCE", days: 1 }));
      expect(created.objectLockEnabled).toEqual(true);
      expect(created.defaultRetention).toEqual({ mode: "GOVERNANCE", days: 1 });
      expect(
        (yield* observeBucket(projectId, region, created.bucketName))?.objectLockEnabled,
      ).toEqual(true);
      expect(yield* observeRetention(projectId, region, created.bucketName)).toEqual({
        mode: "GOVERNANCE",
        days: 1,
      });

      const updated = yield* stack.deploy(archive({ mode: "GOVERNANCE", days: 2 }));
      expect(updated.bucketName).toEqual(created.bucketName);
      expect(updated.defaultRetention).toEqual({ mode: "GOVERNANCE", days: 2 });
      expect(yield* observeRetention(projectId, region, created.bucketName)).toEqual({
        mode: "GOVERNANCE",
        days: 2,
      });

      const removed = yield* stack.deploy(archive(undefined));
      expect(removed.bucketName).toEqual(created.bucketName);
      expect(removed.defaultRetention).toBeUndefined();
      expect(yield* observeRetention(projectId, region, created.bucketName)).toBeUndefined();

      // Object Lock is creation-only: turning it off replaces the bucket.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const lock = yield* Stackit.ObjectStorage.ComplianceLock("Lock", {});
          return yield* Stackit.ObjectStorage.Bucket("Archive", {
            projectId: lock.projectId,
            objectLockEnabled: false,
          });
        }),
      );
      expect(replaced.bucketName).not.toEqual(created.bucketName);
      expect(replaced.objectLockEnabled).toEqual(false);
      expect(
        (yield* observeBucket(projectId, region, replaced.bucketName))?.objectLockEnabled,
      ).toEqual(false);
      expect(yield* waitUntilBucketGone(projectId, region, created.bucketName)).toBeUndefined();

      yield* stack.destroy();

      expect(yield* waitUntilBucketGone(projectId, region, replaced.bucketName)).toBeUndefined();
    }).pipe(logLevel),
  // The compliance lock is a per-project singleton shared with its own suite.
  { ...options, exclusive: "stackit:objectstorage-compliance-lock" },
);

const retryFreshKey = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({ while: (error) => error._tag === "InvalidAccessKeyId", ...s3Propagation }),
  );

test.provider(
  "applies, updates and removes policy, CORS and lifecycle rules",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const denyGroup = (statementId: string) =>
        Effect.gen(function* () {
          const group = yield* Stackit.ObjectStorage.CredentialsGroup("Denied", {});
          return yield* Stackit.ObjectStorage.Bucket("Configured", {
            policy: {
              Statement: [
                {
                  Sid: statementId,
                  Effect: "Deny",
                  Principal: { AWS: group.urn },
                  Action: "s3:*",
                },
              ],
            },
            cors: [{ AllowedMethods: ["GET"], AllowedOrigins: ["https://example.com"] }],
            lifecycleRules: [
              {
                ID: "ExpireTmp",
                Status: "Enabled",
                Filter: { Prefix: "tmp/" },
                Expiration: { Days: 7 },
              },
            ],
          });
        });

      const observed = (bucketName: string) =>
        withOutOfBandS3(
          { projectId, region },
          Effect.all({
            policy: retryFreshKey(s3.getBucketPolicy({ Bucket: bucketName })).pipe(
              Effect.map(
                (response) => JSON.parse(response.Policy!) as { Statement: { Sid: string }[] },
              ),
              Effect.catchTag("NoSuchBucketPolicy", () => Effect.undefined),
            ),
            cors: s3.getBucketCors({ Bucket: bucketName }).pipe(
              Effect.map((response) => response.CORSRules),
              Effect.catchTag("NoSuchCORSConfiguration", () => Effect.undefined),
            ),
            lifecycle: s3.getBucketLifecycleConfiguration({ Bucket: bucketName }).pipe(
              Effect.map((response) => response.Rules),
              Effect.catchTag("NoSuchLifecycleConfiguration", () => Effect.undefined),
            ),
          }),
        );

      const created = yield* stack.deploy(denyGroup("First"));
      const first = yield* observed(created.bucketName);
      expect(first.policy?.Statement.map((statement) => statement.Sid)).toEqual(["First"]);
      expect(first.cors?.[0]?.AllowedOrigins).toEqual(["https://example.com"]);
      expect(first.lifecycle?.map((rule) => rule.ID)).toEqual(["ExpireTmp"]);

      const updated = yield* stack.deploy(denyGroup("Second"));
      expect(updated.bucketName).toEqual(created.bucketName);
      const second = yield* observed(created.bucketName);
      expect(second.policy?.Statement.map((statement) => statement.Sid)).toEqual(["Second"]);

      // Dropping `policy` removes it; empty lists remove the rules.
      yield* stack.deploy(
        Stackit.ObjectStorage.Bucket("Configured", { cors: [], lifecycleRules: [] }),
      );
      const cleared = yield* observed(created.bucketName);
      expect(cleared.policy).toBeUndefined();
      expect(cleared.cors ?? []).toEqual([]);
      expect(cleared.lifecycle ?? []).toEqual([]);

      yield* stack.destroy();

      expect(yield* waitUntilBucketGone(projectId, region, created.bucketName)).toBeUndefined();
    }).pipe(logLevel),
  options,
);

const putTwoObjects = (projectId: string, region: string, bucketName: string) =>
  withOutOfBandS3(
    { projectId, region },
    Effect.all([
      retryFreshKey(s3.putObject({ Bucket: bucketName, Key: "one.txt", Body: "one" })),
      s3.putObject({ Bucket: bucketName, Key: "nested/two.txt", Body: "two" }),
    ]),
  );

test.provider(
  "forceDestroy deletes a bucket with objects",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const bucket = yield* stack.deploy(
        Stackit.ObjectStorage.Bucket("Emptied", { forceDestroy: true }),
      );
      yield* putTwoObjects(projectId, region, bucket.bucketName);

      yield* stack.destroy();

      expect(yield* waitUntilBucketGone(projectId, region, bucket.bucketName)).toBeUndefined();
    }).pipe(logLevel),
  options,
);

test.provider(
  "without forceDestroy a bucket with objects stays",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const bucket = yield* stack.deploy(Stackit.ObjectStorage.Bucket("Kept", {}));
      yield* putTwoObjects(projectId, region, bucket.bucketName);

      const refused = yield* Effect.exit(stack.destroy());
      expect(Exit.isFailure(refused)).toBe(true);
      expect(yield* observeBucket(projectId, region, bucket.bucketName)).toBeDefined();

      // Empty it out of band so the retried destroy can finish.
      yield* withOutOfBandS3(
        { projectId, region },
        retryFreshKey(
          s3.deleteObjects({
            Bucket: bucket.bucketName,
            Delete: { Objects: [{ Key: "one.txt" }, { Key: "nested/two.txt" }] },
          }),
        ),
      );
      yield* stack.destroy();

      expect(yield* waitUntilBucketGone(projectId, region, bucket.bucketName)).toBeUndefined();
    }).pipe(logLevel),
  options,
);
