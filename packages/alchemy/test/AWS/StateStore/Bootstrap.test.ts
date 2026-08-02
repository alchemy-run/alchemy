import * as AWS from "@/AWS";
import {
  bootstrap,
  STATE_STACK_NAME,
  teardown,
} from "@/AWS/StateStore/Bootstrap.ts";
import { makeS3State } from "@/AWS";
import type { ResourceState } from "@/State";
import { hasLocalBootstrapStack } from "@/State/Bootstrap.ts";
import * as Test from "@/Test/Alchemy";
import * as kms from "@distilled.cloud/aws/kms";
import * as s3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

// Isolated from the shared testing state bucket/key: this suite creates
// and destroys its own store end-to-end.
const KMS_ALIAS = "alias/alchemy-state-btest" as const;
const bucketNameFor = (accountId: string, region: string) =>
  `alchemy-state-btest-${accountId}-${region}-an`.toLowerCase();

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
