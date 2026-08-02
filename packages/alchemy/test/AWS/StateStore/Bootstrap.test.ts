import * as AWS from "@/AWS";
import {
  bootstrap,
  STATE_STACK_NAME,
  teardown,
} from "@/AWS/StateStore/Bootstrap.ts";
import { makeS3State } from "@/AWS";
import {
  StateStoreError,
  type ResourceState,
  type StateService,
} from "@/State";
import { hasLocalBootstrapStack } from "@/State/Bootstrap.ts";
import { makeLocalState } from "@/State/LocalState.ts";
import * as Test from "@/Test/Alchemy";
import * as kms from "@distilled.cloud/aws/kms";
import * as s3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

// Isolated from the shared testing state bucket/key: every test in this
// suite creates and destroys its own store end-to-end, under its own
// bucket + alias, so the tests are independent and safe to run
// concurrently.
const KMS_ALIAS = "alias/alchemy-state-btest" as const;
const bucketNameFor = (accountId: string, region: string) =>
  `alchemy-state-btest-${accountId}-${region}-an`.toLowerCase();

/** Per-failure-mode isolation: its own bucket + alias per suffix. */
const isolated = (suffix: string) =>
  Effect.gen(function* () {
    const { accountId, region } = yield* AWS.AWSEnvironment.current;
    return {
      bucketName:
        `alchemy-state-b${suffix}-${accountId}-${region}-an`.toLowerCase(),
      kmsAlias: `alias/alchemy-state-b${suffix}` as const,
      region,
    };
  });

const secretRow = (fqn: string, secret: string): ResourceState =>
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
    props: { apiKey: Redacted.make(secret) },
    attr: {},
  }) as ResourceState;

const readSecret = (state: StateService, fqn: string) =>
  Effect.gen(function* () {
    const revived = (yield* state.get({
      stack: "BootstrapSecretTest",
      stage: "test",
      fqn,
    })) as ResourceState | undefined;
    return Redacted.value(
      (revived?.props as { apiKey: Redacted.Redacted<string> }).apiKey,
    );
  });

const writeSecret = (state: StateService, fqn: string, secret: string) =>
  state.set({
    stack: "BootstrapSecretTest",
    stage: "test",
    fqn,
    value: secretRow(fqn, secret),
  });

/** Version-aware bucket wipe + delete, for simulating out-of-band loss. */
const nukeBucket = (bucketName: string) =>
  Effect.gen(function* () {
    let truncated = true;
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    while (truncated) {
      const page = yield* s3.listObjectVersions({
        Bucket: bucketName,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      });
      const objects = [
        ...(page.Versions ?? []),
        ...(page.DeleteMarkers ?? []),
      ].map((v) => ({ Key: v.Key!, VersionId: v.VersionId }));
      if (objects.length > 0) {
        yield* s3.deleteObjects({
          Bucket: bucketName,
          Delete: { Objects: objects, Quiet: true },
        });
      }
      truncated = page.IsTruncated === true;
      keyMarker = page.NextKeyMarker;
      versionIdMarker = page.NextVersionIdMarker;
    }
    yield* s3
      .deleteBucket({ Bucket: bucketName })
      .pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));
  });

test.provider(
  "bootstrap deploys the state store stack, hoists state, and tears down",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWS.AWSEnvironment.current;
      const bucketName = bucketNameFor(accountId, region);
      const options = { bucketName, kmsAlias: KMS_ALIAS };

      // Clean slate from any prior interrupted run.
      yield* teardown({ ...options, force: true }).pipe(Effect.orDie);

      yield* Effect.gen(function* () {
        // 1. Fresh bootstrap: deploy with local state, hoist into the bucket.
        const result = yield* bootstrap(options);
        expect(result.bucketName).toBe(bucketName);

        // The bucket exists with the secure defaults from the stack.
        const versioning = yield* s3.getBucketVersioning({
          Bucket: bucketName,
        });
        expect(versioning.Status).toBe("Enabled");
        const publicAccess = yield* s3.getPublicAccessBlock({
          Bucket: bucketName,
        });
        expect(publicAccess.PublicAccessBlockConfiguration).toEqual({
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        });

        // The alias resolves to an enabled key.
        const key = yield* kms.describeKey({ KeyId: KMS_ALIAS });
        expect(key.KeyMetadata?.KeyState).toBe("Enabled");
        const keyId = key.KeyMetadata?.KeyId;

        // The stack's own state was hoisted into the bucket it created…
        const s3State = yield* makeS3State(options);
        const fqns = yield* s3State.list({
          stack: STATE_STACK_NAME,
          stage: region,
        });
        expect([...fqns].sort()).toEqual([
          "StateAlias",
          "StateBucket",
          "StateKey",
        ]);
        // …and the local copy is gone.
        expect(
          yield* hasLocalBootstrapStack(
            STATE_STACK_NAME,
            `testing_${bucketName}`,
          ),
        ).toBe(false);

        // 2. Secrets round-trip through the bootstrapped store under the
        //    stack-managed key.
        const value = {
          resourceType: "test:resource",
          namespace: undefined,
          fqn: "SecretResource",
          logicalId: "SecretResource",
          instanceId: "instance-SecretResource",
          providerVersion: 1,
          status: "created",
          downstream: [],
          bindings: [],
          props: { apiKey: Redacted.make("sk-live-bootstrap-secret") },
          attr: {},
        } as ResourceState;
        yield* s3State.set({
          stack: "BootstrapSecretTest",
          stage: "test",
          fqn: value.fqn,
          value,
        });
        const raw = yield* s3
          .getObject({
            Bucket: bucketName,
            Key: "BootstrapSecretTest/test/SecretResource.json",
          })
          .pipe(
            Effect.flatMap((r) =>
              r.Body === undefined
                ? Effect.succeed("")
                : Stream.mkString(Stream.decodeText(r.Body)),
            ),
          );
        expect(raw).toContain("__secret__");
        expect(raw).not.toContain("sk-live-bootstrap-secret");
        const revived = (yield* s3State.get({
          stack: "BootstrapSecretTest",
          stage: "test",
          fqn: "SecretResource",
        })) as ResourceState | undefined;
        expect(
          Redacted.value(
            (revived?.props as { apiKey: Redacted.Redacted<string> }).apiKey,
          ),
        ).toBe("sk-live-bootstrap-secret");

        // 3. Idempotent re-run: converges against the state in the bucket
        //    without minting a new key.
        yield* bootstrap(options);
        const keyAfter = yield* kms.describeKey({ KeyId: KMS_ALIAS });
        expect(keyAfter.KeyMetadata?.KeyId).toBe(keyId);

        // 4. Teardown refuses while foreign stack state is present…
        const refused = yield* teardown(options).pipe(
          Effect.map(() => "completed"),
          Effect.catchTag("StateStoreError", (e) =>
            Effect.succeed(
              e.message.includes("BootstrapSecretTest")
                ? "refused"
                : `wrong-message: ${e.message}`,
            ),
          ),
        );
        expect(refused).toBe("refused");

        // …and with force deletes bucket, alias, and schedules the key.
        yield* teardown({ ...options, force: true });
        const bucketGone = yield* s3.headBucket({ Bucket: bucketName }).pipe(
          Effect.map(() => false),
          Effect.catchTag(["NotFound", "NoSuchBucket"], () =>
            Effect.succeed(true),
          ),
        );
        expect(bucketGone).toBe(true);
        const aliasGone = yield* kms.describeKey({ KeyId: KMS_ALIAS }).pipe(
          Effect.map(() => false),
          Effect.catchTag("NotFoundException", () => Effect.succeed(true)),
        );
        expect(aliasGone).toBe(true);
        if (keyId !== undefined) {
          const keyState = yield* kms.describeKey({ KeyId: keyId });
          expect(keyState.KeyMetadata?.KeyState).toBe("PendingDeletion");
        }
      }).pipe(
        Effect.ensuring(
          teardown({ ...options, force: true }).pipe(Effect.orDie),
        ),
      );
    }),
  { timeout: 300_000 },
);

test.provider(
  "resumes an interrupted bootstrap from the stranded local stack",
  () =>
    Effect.gen(function* () {
      const { bucketName, kmsAlias, region } = yield* isolated("resume");
      const options = { bucketName, kmsAlias };
      const localStage = `testing_${bucketName}`;

      yield* teardown({ ...options, force: true }).pipe(Effect.orDie);

      yield* Effect.gen(function* () {
        yield* bootstrap(options);
        const keyId = (yield* kms.describeKey({ KeyId: kmsAlias })).KeyMetadata
          ?.KeyId;

        // Simulate a crash after the hoist but before the local cleanup:
        // copy the stack's rows from S3 back into the local store, and
        // drop one row from S3 (as if the hoist had also been partial).
        const s3State = yield* makeS3State(options);
        const localState = yield* makeLocalState();
        const fqns = yield* s3State.list({
          stack: STATE_STACK_NAME,
          stage: region,
        });
        yield* Effect.forEach(fqns, (fqn) =>
          Effect.flatMap(
            s3State.get({ stack: STATE_STACK_NAME, stage: region, fqn }),
            (value) =>
              value === undefined
                ? Effect.void
                : localState
                    .set({
                      stack: STATE_STACK_NAME,
                      stage: localStage,
                      fqn,
                      value,
                    })
                    .pipe(Effect.asVoid),
          ),
        );
        yield* s3State.delete({
          stack: STATE_STACK_NAME,
          stage: region,
          fqn: "StateAlias",
        });

        // The re-run must finish the bootstrap: converge, re-hoist the
        // missing row, clean up the local stack, and keep the same key.
        yield* bootstrap(options);
        expect(
          yield* hasLocalBootstrapStack(STATE_STACK_NAME, localStage),
        ).toBe(false);
        const fqnsAfter = yield* s3State.list({
          stack: STATE_STACK_NAME,
          stage: region,
        });
        expect([...fqnsAfter].sort()).toEqual([
          "StateAlias",
          "StateBucket",
          "StateKey",
        ]);
        const keyAfter = (yield* kms.describeKey({ KeyId: kmsAlias }))
          .KeyMetadata?.KeyId;
        expect(keyAfter).toBe(keyId);
      }).pipe(
        Effect.ensuring(
          teardown({ ...options, force: true }).pipe(Effect.orDie),
        ),
      );
    }),
  { timeout: 300_000 },
);

test.provider(
  "heals an out-of-band key deletion + alias removal (the nuke scenario)",
  () =>
    Effect.gen(function* () {
      const { bucketName, kmsAlias } = yield* isolated("nuked");
      const options = { bucketName, kmsAlias };

      yield* teardown({ ...options, force: true }).pipe(Effect.orDie);

      yield* Effect.gen(function* () {
        yield* bootstrap(options);
        const s3State = yield* makeS3State(options);
        yield* writeSecret(s3State, "NukeSurvivor", "sk-live-nuke-survivor");
        const keyId = (yield* kms.describeKey({ KeyId: kmsAlias })).KeyMetadata
          ?.KeyId;
        expect(keyId).toBeDefined();

        // Out-of-band cleanup: alias deleted, key scheduled for deletion.
        yield* kms.deleteAlias({ AliasName: kmsAlias });
        yield* kms.scheduleKeyDeletion({
          KeyId: keyId!,
          PendingWindowInDays: 7,
        });

        // Re-bootstrap must recover the SAME key (replacing it would
        // strand the encrypted state) and restore the alias.
        yield* bootstrap(options);
        const after = yield* kms.describeKey({ KeyId: kmsAlias });
        expect(after.KeyMetadata?.KeyId).toBe(keyId);
        expect(after.KeyMetadata?.KeyState).toBe("Enabled");

        // Secrets written before the nuke still read.
        const fresh = yield* makeS3State(options);
        expect(yield* readSecret(fresh, "NukeSurvivor")).toBe(
          "sk-live-nuke-survivor",
        );
      }).pipe(
        Effect.ensuring(
          teardown({ ...options, force: true }).pipe(Effect.orDie),
        ),
      );
    }),
  { timeout: 300_000 },
);

test.provider(
  "re-bootstraps after the state bucket is deleted out-of-band",
  () =>
    Effect.gen(function* () {
      const { bucketName, kmsAlias } = yield* isolated("bktgone");
      const options = { bucketName, kmsAlias };

      yield* teardown({ ...options, force: true }).pipe(Effect.orDie);

      yield* Effect.gen(function* () {
        yield* bootstrap(options);
        // The bucket (and the stack state inside it) vanishes.
        yield* nukeBucket(bucketName);

        // Bootstrap starts over: recreates the bucket, adopts the
        // still-existing alias, and produces a fully working store.
        yield* bootstrap(options);
        const key = yield* kms.describeKey({ KeyId: kmsAlias });
        expect(key.KeyMetadata?.KeyState).toBe("Enabled");
        const s3State = yield* makeS3State(options);
        yield* writeSecret(s3State, "AfterLoss", "sk-live-after-loss");
        expect(yield* readSecret(s3State, "AfterLoss")).toBe(
          "sk-live-after-loss",
        );
      }).pipe(
        Effect.ensuring(
          teardown({ ...options, force: true }).pipe(Effect.orDie),
        ),
      );
    }),
  { timeout: 300_000 },
);

test.provider(
  "restores a deleted data-key object from bucket versions instead of stranding secrets",
  () =>
    Effect.gen(function* () {
      const { bucketName, kmsAlias } = yield* isolated("dkgone");
      const options = { bucketName, kmsAlias };

      yield* teardown({ ...options, force: true }).pipe(Effect.orDie);

      yield* Effect.gen(function* () {
        yield* bootstrap(options);
        const s3State = yield* makeS3State(options);
        yield* writeSecret(s3State, "VersionedSecret", "sk-live-versioned");

        // Out-of-band delete of the wrapped data key object. Without
        // version restore a fresh data key would be minted and every
        // existing secret would become permanently unreadable.
        yield* s3.deleteObject({
          Bucket: bucketName,
          Key: "__state_key__.json",
        });

        const fresh = yield* makeS3State(options);
        expect(yield* readSecret(fresh, "VersionedSecret")).toBe(
          "sk-live-versioned",
        );
        // The object is re-established as the current version.
        const restored = yield* s3
          .getObject({ Bucket: bucketName, Key: "__state_key__.json" })
          .pipe(
            Effect.map(() => true),
            Effect.catchTag("NoSuchKey", () => Effect.succeed(false)),
          );
        expect(restored).toBe(true);
      }).pipe(
        Effect.ensuring(
          teardown({ ...options, force: true }).pipe(Effect.orDie),
        ),
      );
    }),
  { timeout: 300_000 },
);

test.provider(
  "migrates a legacy imperative store: adopts the bucket and re-wraps the data key",
  () =>
    Effect.gen(function* () {
      const { bucketName, kmsAlias } = yield* isolated("legacy");
      const options = { bucketName, kmsAlias };

      yield* teardown({ ...options, force: true }).pipe(Effect.orDie);

      yield* Effect.gen(function* () {
        // The old world: the silent imperative path creates the bucket,
        // mints a key behind the alias, and wraps a data key with it.
        const legacyState = yield* makeS3State(options);
        yield* writeSecret(legacyState, "LegacySecret", "sk-live-legacy");
        const legacyKeyId = (yield* kms.describeKey({ KeyId: kmsAlias }))
          .KeyMetadata?.KeyId;
        expect(legacyKeyId).toBeDefined();

        // Bootstrap takes over: adopts the bucket + alias onto the
        // stack-managed key and re-wraps the data key under it, so the
        // legacy key stops being load-bearing.
        yield* bootstrap(options);
        const aliasTarget = (yield* kms.describeKey({ KeyId: kmsAlias }))
          .KeyMetadata?.KeyId;
        expect(aliasTarget).toBeDefined();
        expect(aliasTarget).not.toBe(legacyKeyId);

        const wrapped = yield* s3
          .getObject({ Bucket: bucketName, Key: "__state_key__.json" })
          .pipe(
            Effect.flatMap((r) =>
              r.Body === undefined
                ? Effect.succeed("")
                : Stream.mkString(Stream.decodeText(r.Body)),
            ),
            Effect.map((text) => JSON.parse(text) as { keyId?: string }),
          );
        const wrappingKey = (yield* kms.describeKey({
          KeyId: wrapped.keyId!,
        })).KeyMetadata?.KeyId;
        expect(wrappingKey).toBe(aliasTarget);

        // Old secrets still read, new secrets still write — through a
        // fresh store instance (fresh codec cache).
        const fresh = yield* makeS3State(options);
        expect(yield* readSecret(fresh, "LegacySecret")).toBe("sk-live-legacy");
        yield* writeSecret(fresh, "PostMigration", "sk-live-post-migration");
        expect(yield* readSecret(fresh, "PostMigration")).toBe(
          "sk-live-post-migration",
        );

        // Retire the now-unreferenced legacy key.
        yield* kms.scheduleKeyDeletion({
          KeyId: legacyKeyId!,
          PendingWindowInDays: 7,
        });
      }).pipe(
        Effect.ensuring(
          teardown({ ...options, force: true }).pipe(Effect.orDie),
        ),
      );
    }),
  { timeout: 300_000 },
);

test.provider(
  "the consent seam fires for missing infrastructure and never creates silently",
  () =>
    Effect.gen(function* () {
      const { bucketName, kmsAlias } = yield* isolated("consent");
      const consent: Array<string> = [];

      // Missing bucket: the hook fires before anything is created; its
      // failure aborts the operation and the bucket is NOT created.
      const gated = yield* makeS3State({
        bucketName,
        kmsAlias,
        onMissingInfra: (which) =>
          Effect.sync(() => {
            consent.push(which);
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new StateStoreError({ message: `declined:${which}` }),
              ),
            ),
          ),
      });
      const result = yield* gated.listStacks().pipe(
        Effect.map(() => "created"),
        Effect.catchTag("StateStoreError", (e) => Effect.succeed(e.message)),
      );
      expect(result).toBe("declined:bucket");
      expect(consent).toEqual(["bucket"]);
      const bucketExists = yield* s3.headBucket({ Bucket: bucketName }).pipe(
        Effect.map(() => true),
        Effect.catchTag(["NotFound", "NoSuchBucket"], () =>
          Effect.succeed(false),
        ),
      );
      expect(bucketExists).toBe(false);
    }),
  { timeout: 120_000 },
);

test.provider(
  "teardown is idempotent and survives its own crash windows",
  () =>
    Effect.gen(function* () {
      const { bucketName, kmsAlias } = yield* isolated("tdown");
      const options = { bucketName, kmsAlias };

      yield* teardown({ ...options, force: true }).pipe(Effect.orDie);

      yield* Effect.gen(function* () {
        yield* bootstrap(options);
        const keyId = (yield* kms.describeKey({ KeyId: kmsAlias })).KeyMetadata
          ?.KeyId;

        // Simulate the worst crash window: the key is already pending
        // deletion (as if a previous teardown died right after
        // scheduling it) while alias + bucket still exist.
        yield* kms.scheduleKeyDeletion({
          KeyId: keyId!,
          PendingWindowInDays: 7,
        });

        // Teardown completes from that state…
        yield* teardown({ ...options, force: true });
        // …and a second run is a clean no-op.
        yield* teardown({ ...options, force: true });

        const bucketGone = yield* s3.headBucket({ Bucket: bucketName }).pipe(
          Effect.map(() => false),
          Effect.catchTag(["NotFound", "NoSuchBucket"], () =>
            Effect.succeed(true),
          ),
        );
        expect(bucketGone).toBe(true);
        const aliasGone = yield* kms.describeKey({ KeyId: kmsAlias }).pipe(
          Effect.map(() => false),
          Effect.catchTag("NotFoundException", () => Effect.succeed(true)),
        );
        expect(aliasGone).toBe(true);
        // And bootstrap can still resurrect the store afterwards.
        yield* bootstrap(options);
        const s3State = yield* makeS3State(options);
        yield* writeSecret(s3State, "Reborn", "sk-live-reborn");
        expect(yield* readSecret(s3State, "Reborn")).toBe("sk-live-reborn");
      }).pipe(
        Effect.ensuring(
          teardown({ ...options, force: true }).pipe(Effect.orDie),
        ),
      );
    }),
  { timeout: 300_000 },
);
