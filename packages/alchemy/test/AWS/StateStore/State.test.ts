import * as AWS from "@/AWS";
import { makeS3State } from "@/AWS";
import { createStateBucketName } from "@/AWS/StateStore/State.ts";
import type { ResourceState, StateService } from "@/State";
import { encodeState } from "@/State/StateEncoding.ts";
import * as Test from "@/Test/Alchemy";
import * as kms from "@distilled.cloud/aws/kms";
import * as s3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

const STACK = "S3StateStoreTestStack";

/**
 * Guaranteed out-of-band cleanup: `deleteStack` is idempotent (list +
 * batched delete), and `Effect.orDie` collapses the finalizer's error
 * channel to `never` so it is a valid `Effect.ensuring` finalizer.
 * Every test pre-cleans AND finalizes with this so a failing assertion
 * can never leave state objects behind in the bucket.
 */
const cleanStage = (state: StateService, stage: string) =>
  state.deleteStack({ stack: STACK, stage }).pipe(Effect.orDie);

const resource = (fqn: string, attr: Record<string, unknown>): ResourceState =>
  ({
    resourceType: "test:resource",
    namespace: undefined,
    fqn,
    logicalId: fqn,
    instanceId: `instance-${fqn}`,
    providerVersion: 1,
    status: "created",
    downstream: [],
    bindings: [],
    props: {},
    attr,
  }) as ResourceState;

test.provider(
  "set/get/list/delete round-trips state through S3",
  () =>
    Effect.gen(function* () {
      const state = yield* makeS3State({ prefix: "test-state" });
      const stage = "round-trip";

      // start from a clean slate (idempotent)
      yield* state.deleteStack({ stack: STACK, stage });

      yield* Effect.gen(function* () {
        const a = resource("Parent/ResourceA", { value: "a" });
        const b = resource("ResourceB", { value: "b" });

        yield* state.set({ stack: STACK, stage, fqn: a.fqn, value: a });
        yield* state.set({ stack: STACK, stage, fqn: b.fqn, value: b });

        expect(yield* state.get({ stack: STACK, stage, fqn: a.fqn })).toEqual(
          a,
        );
        expect(
          yield* state.get({ stack: STACK, stage, fqn: "does-not-exist" }),
        ).toBeUndefined();

        const fqns = yield* state.list({ stack: STACK, stage });
        expect([...fqns].sort()).toEqual(["Parent/ResourceA", "ResourceB"]);

        expect(yield* state.listStacks()).toContain(STACK);
        expect(yield* state.listStages(STACK)).toContain(stage);

        yield* state.delete({ stack: STACK, stage, fqn: a.fqn });
        expect(
          yield* state.get({ stack: STACK, stage, fqn: a.fqn }),
        ).toBeUndefined();
        // deleting a missing resource is a no-op
        yield* state.delete({ stack: STACK, stage, fqn: a.fqn });

        yield* state.deleteStack({ stack: STACK, stage });
        expect(yield* state.list({ stack: STACK, stage })).toEqual([]);
      }).pipe(Effect.ensuring(cleanStage(state, stage)));
    }),
  { timeout: 120_000 },
);

test.provider(
  "existing state buckets converge to secure defaults",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWS.AWSEnvironment.current;
      const bucketName = createStateBucketName(`security-${accountId}`, region);
      const deleteBucket = s3.deleteBucket({ Bucket: bucketName }).pipe(
        Effect.catchTag("NoSuchBucket", () => Effect.void),
        Effect.orDie,
      );

      yield* s3
        .deleteBucket({ Bucket: bucketName })
        .pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));

      yield* Effect.gen(function* () {
        // First create the bucket, then simulate out-of-band configuration
        // drift. The second state service targets the SAME existing bucket and
        // must repair every setting from observed cloud state.
        const initial = yield* makeS3State({
          bucketName,
          prefix: "security-test",
        });
        yield* initial.listStacks();

        yield* s3.putBucketVersioning({
          Bucket: bucketName,
          VersioningConfiguration: { Status: "Suspended" },
        });
        yield* s3.putBucketEncryption({
          Bucket: bucketName,
          ServerSideEncryptionConfiguration: {
            Rules: [
              {
                ApplyServerSideEncryptionByDefault: {
                  SSEAlgorithm: "aws:kms",
                },
              },
            ],
          },
        });
        yield* s3.putPublicAccessBlock({
          Bucket: bucketName,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: false,
            IgnorePublicAcls: false,
            BlockPublicPolicy: false,
            RestrictPublicBuckets: false,
          },
        });
        yield* s3.putBucketOwnershipControls({
          Bucket: bucketName,
          OwnershipControls: {
            Rules: [{ ObjectOwnership: "ObjectWriter" }],
          },
        });

        const secured = yield* makeS3State({
          bucketName,
          prefix: "security-test",
        });
        yield* secured.listStacks();

        const versioning = yield* s3.getBucketVersioning({
          Bucket: bucketName,
        });
        expect(versioning.Status).toBe("Enabled");

        const encryption = yield* s3.getBucketEncryption({
          Bucket: bucketName,
        });
        expect(
          encryption.ServerSideEncryptionConfiguration?.Rules?.[0]
            ?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm,
        ).toBe("AES256");

        const publicAccess = yield* s3.getPublicAccessBlock({
          Bucket: bucketName,
        });
        expect(publicAccess.PublicAccessBlockConfiguration).toEqual({
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        });

        const ownership = yield* s3.getBucketOwnershipControls({
          Bucket: bucketName,
        });
        expect(ownership.OwnershipControls?.Rules?.[0]?.ObjectOwnership).toBe(
          "BucketOwnerEnforced",
        );
      }).pipe(Effect.ensuring(deleteBucket));
    }),
  { timeout: 120_000 },
);

test.provider(
  "stack outputs are stored separately from resources",
  () =>
    Effect.gen(function* () {
      const state = yield* makeS3State({ prefix: "test-state" });
      const stage = "outputs";

      yield* state.deleteStack({ stack: STACK, stage });

      yield* Effect.gen(function* () {
        expect(yield* state.getOutput({ stack: STACK, stage })).toBeUndefined();

        yield* state.setOutput({
          stack: STACK,
          stage,
          value: { url: "https://example.com" },
        });
        expect(yield* state.getOutput({ stack: STACK, stage })).toEqual({
          url: "https://example.com",
        });

        // the output bookkeeping object must not leak into list()
        expect(yield* state.list({ stack: STACK, stage })).toEqual([]);

        yield* state.deleteStack({ stack: STACK, stage });
        expect(yield* state.getOutput({ stack: STACK, stage })).toBeUndefined();
      }).pipe(Effect.ensuring(cleanStage(state, stage)));
    }),
  { timeout: 120_000 },
);

test.provider(
  "getReplacedResources returns only replaced resources",
  () =>
    Effect.gen(function* () {
      const state = yield* makeS3State({ prefix: "test-state" });
      const stage = "replaced";

      yield* state.deleteStack({ stack: STACK, stage });

      yield* Effect.gen(function* () {
        const created = resource("Created", { value: "created" });
        const replaced = {
          ...resource("Replaced", { value: "replaced" }),
          status: "replaced",
        } as ResourceState;

        yield* state.set({
          stack: STACK,
          stage,
          fqn: created.fqn,
          value: created,
        });
        yield* state.set({
          stack: STACK,
          stage,
          fqn: replaced.fqn,
          value: replaced,
        });

        const result = yield* state.getReplacedResources({
          stack: STACK,
          stage,
        });
        expect(result.map((r) => r.fqn)).toEqual(["Replaced"]);
      }).pipe(Effect.ensuring(cleanStage(state, stage)));
    }),
  { timeout: 120_000 },
);

test.provider(
  "rolls forward legacy plaintext state: reads without KMS, re-writes encrypted",
  () =>
    Effect.gen(function* () {
      // Distinct prefix so the per-prefix data-key object proves exactly
      // when KMS was (and was not) engaged.
      const prefix = "test-state-legacy";
      const state = yield* makeS3State({ prefix });
      const stage = "roll-forward";
      const { accountId, region } = yield* AWS.AWSEnvironment.current;
      const bucket = createStateBucketName(accountId, region);
      const objectKey = `${prefix}/${STACK}/${stage}/LegacyResource.json`;
      const dataKeyObject = `${prefix}/__state_key__.json`;

      // Runs the bucket-ensure and clears any prior run (incl. the
      // per-prefix data key, so the KMS-laziness assertion is fresh).
      yield* state.deleteStack({ stack: STACK, stage });
      yield* s3
        .deleteObject({ Bucket: bucket, Key: dataKeyObject })
        .pipe(Effect.orDie);

      const readRaw = s3
        .getObject({ Bucket: bucket, Key: objectKey })
        .pipe(
          Effect.flatMap((r) =>
            r.Body === undefined
              ? Effect.succeed("")
              : Stream.mkString(Stream.decodeText(r.Body)),
          ),
        );
      const dataKeyExists = s3
        .getObject({ Bucket: bucket, Key: dataKeyObject })
        .pipe(
          Effect.map(() => true),
          Effect.catchTag("NoSuchKey", () => Effect.succeed(false)),
        );

      yield* Effect.gen(function* () {
        const value = {
          ...resource("LegacyResource", { url: "https://example.com" }),
          props: { apiKey: Redacted.make("sk-live-legacy-secret") },
        } as ResourceState;

        // 1. The old world: hand-write the exact plaintext-marker JSON a
        //    pre-encryption version persisted (encodeState without a
        //    codec is that legacy writer).
        yield* s3.putObject({
          Bucket: bucket,
          Key: objectKey,
          Body: JSON.stringify(encodeState(value), null, 2),
          ContentType: "application/json",
        });

        // 2. The new version reads it — and because there is no
        //    __secret__ marker, without engaging KMS at all.
        const revived = (yield* state.get({
          stack: STACK,
          stage,
          fqn: "LegacyResource",
        })) as ResourceState | undefined;
        expect(
          Redacted.value(
            (revived?.props as { apiKey: Redacted.Redacted<string> }).apiKey,
          ),
        ).toBe("sk-live-legacy-secret");
        expect(yield* dataKeyExists).toBe(false);

        // 3. The next write (what any subsequent deploy does) migrates
        //    the object to the encrypted envelope.
        yield* state.set({
          stack: STACK,
          stage,
          fqn: "LegacyResource",
          value: revived!,
        });
        const migrated = yield* readRaw;
        expect(migrated).toContain("__secret__");
        expect(migrated).not.toContain("__redacted__");
        expect(migrated).not.toContain("sk-live-legacy-secret");
        expect(yield* dataKeyExists).toBe(true);

        // 4. The migrated state round-trips.
        const reread = (yield* state.get({
          stack: STACK,
          stage,
          fqn: "LegacyResource",
        })) as ResourceState | undefined;
        expect(
          Redacted.value(
            (reread?.props as { apiKey: Redacted.Redacted<string> }).apiKey,
          ),
        ).toBe("sk-live-legacy-secret");
      }).pipe(Effect.ensuring(cleanStage(state, stage)));
    }),
  { timeout: 120_000 },
);

test.provider(
  "secret-free state never engages KMS",
  () =>
    Effect.gen(function* () {
      // Distinct prefix: the KMS-wrapped data key object is per-prefix,
      // so its absence proves the codec was never resolved for this
      // store — no KMS permission or key is needed without secrets.
      const prefix = "test-state-plain";
      const state = yield* makeS3State({ prefix });
      const stage = "no-secrets";

      yield* state.deleteStack({ stack: STACK, stage });

      yield* Effect.gen(function* () {
        const value = resource("PlainResource", { url: "https://example.com" });
        yield* state.set({ stack: STACK, stage, fqn: value.fqn, value });
        expect(
          yield* state.get({ stack: STACK, stage, fqn: value.fqn }),
        ).toEqual(value);

        const { accountId, region } = yield* AWS.AWSEnvironment.current;
        const wrappedKey = yield* s3
          .getObject({
            Bucket: createStateBucketName(accountId, region),
            Key: `${prefix}/__state_key__.json`,
          })
          .pipe(
            Effect.map(() => "exists"),
            Effect.catchTag("NoSuchKey", () => Effect.succeed("absent")),
          );
        expect(wrappedKey).toBe("absent");
      }).pipe(Effect.ensuring(cleanStage(state, stage)));
    }),
  { timeout: 120_000 },
);

test.provider(
  "recovers the KMS state key from a pending deletion",
  () =>
    Effect.gen(function* () {
      const stage = "kms-recovery";

      // Ensure the alias key and wrapped data key exist by writing a
      // secret through a store first.
      const before = yield* makeS3State({ prefix: "test-state" });
      yield* before.deleteStack({ stack: STACK, stage });

      yield* Effect.gen(function* () {
        const value = {
          ...resource("RecoveryResource", {}),
          props: { apiKey: Redacted.make("sk-live-recovery-secret") },
        } as ResourceState;
        yield* before.set({ stack: STACK, stage, fqn: value.fqn, value });

        // Schedule the state key for deletion out-of-band — exactly what
        // an account-wide cleanup (`bun nuke`) does. Resolve the key from
        // the wrapped data key object rather than the alias: a cleanup
        // deletes the alias immediately while the key sits in its
        // pending-deletion window.
        const { accountId, region } = yield* AWS.AWSEnvironment.current;
        const wrappedBody = yield* s3
          .getObject({
            Bucket: createStateBucketName(accountId, region),
            Key: "test-state/__state_key__.json",
          })
          .pipe(
            Effect.flatMap((r) =>
              r.Body === undefined
                ? Effect.succeed("")
                : Stream.mkString(Stream.decodeText(r.Body)),
            ),
          );
        const keyId = (JSON.parse(wrappedBody) as { keyId?: string }).keyId;
        expect(keyId).toBeDefined();
        yield* kms
          .scheduleKeyDeletion({ KeyId: keyId!, PendingWindowInDays: 7 })
          .pipe(
            // another concurrent test may have raced the same transition
            Effect.catchTag("KMSInvalidStateException", () => Effect.void),
          );

        // A fresh store (fresh codec cache) must cancel the deletion,
        // re-enable the key, and read the secret back.
        const after = yield* makeS3State({ prefix: "test-state" });
        const revived = (yield* after.get({
          stack: STACK,
          stage,
          fqn: "RecoveryResource",
        })) as ResourceState | undefined;
        expect(
          Redacted.value(
            (revived?.props as { apiKey: Redacted.Redacted<string> }).apiKey,
          ),
        ).toBe("sk-live-recovery-secret");

        const recovered = yield* kms.describeKey({ KeyId: keyId! });
        expect(recovered.KeyMetadata?.KeyState).toBe("Enabled");
      }).pipe(Effect.ensuring(cleanStage(before, stage)));
    }),
  { timeout: 120_000 },
);

test.provider(
  "secrets are KMS-encrypted at rest and revive on read",
  () =>
    Effect.gen(function* () {
      const state = yield* makeS3State({ prefix: "test-state" });
      const stage = "kms-secrets";

      yield* state.deleteStack({ stack: STACK, stage });

      yield* Effect.gen(function* () {
        const value = {
          ...resource("SecretResource", { url: "https://example.com" }),
          props: { apiKey: Redacted.make("sk-live-kms-secret") },
        } as ResourceState;
        yield* state.set({ stack: STACK, stage, fqn: value.fqn, value });

        const { accountId, region } = yield* AWS.AWSEnvironment.current;
        const bucket = createStateBucketName(accountId, region);
        const readRaw = (key: string) =>
          s3
            .getObject({ Bucket: bucket, Key: key })
            .pipe(
              Effect.flatMap((r) =>
                r.Body === undefined
                  ? Effect.succeed("")
                  : Stream.mkString(Stream.decodeText(r.Body)),
              ),
            );

        // The raw S3 object holds an encrypted envelope, never plaintext.
        const raw = yield* readRaw(
          `test-state/${STACK}/${stage}/SecretResource.json`,
        );
        expect(raw).toContain("__secret__");
        expect(raw).not.toContain("sk-live-kms-secret");
        // Non-secret state stays introspectable.
        expect(raw).toContain("https://example.com");

        // The KMS-wrapped data key is persisted at the prefix root.
        const wrapped = yield* readRaw("test-state/__state_key__.json");
        expect(wrapped).toContain("ciphertext");
        expect(wrapped).not.toContain("sk-live-kms-secret");

        // Reading through the store unwraps the data key via KMS and
        // decrypts back into a Redacted.
        const revived = (yield* state.get({
          stack: STACK,
          stage,
          fqn: "SecretResource",
        })) as ResourceState | undefined;
        expect(
          Redacted.value(
            (revived?.props as { apiKey: Redacted.Redacted<string> }).apiKey,
          ),
        ).toBe("sk-live-kms-secret");
      }).pipe(Effect.ensuring(cleanStage(state, stage)));
    }),
  { timeout: 120_000 },
);
