import { createHash } from "node:crypto";
import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as kms from "@distilled.cloud/aws/kms";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Alchemist from "alchemy/Alchemist";
import type { ResourceState } from "alchemy/State";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: AWS.providers() });

/** Run with `CI` set, as a CI deploy would. */
const inCI = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.CI;
      process.env.CI = "true";
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.CI;
        else process.env.CI = previous;
      }),
  );

const bucketExists = (bucket: string) =>
  s3.headBucket({ Bucket: bucket }).pipe(
    Effect.as(true),
    Effect.catchTag(["NotFound", "NoSuchBucket"], () => Effect.succeed(false)),
  );

test.provider(
  "a named S3 state store bootstraps, serves state and tears down",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      // Never the default store, which every other run on the account uses.
      const name = "lifecycle";
      const bucket = `alchemy-state-lifecycle-${accountId}-${region}-an`;
      const target = { type: "provider", backend: "aws-s3", name } as const;
      const alchemist = Alchemist.layer();

      yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));

      const created = yield* Alchemist.State.bootstrap(target).pipe(Effect.provide(alchemist));
      expect(created.status).toBe("created");
      expect(yield* bucketExists(bucket)).toBe(true);
      expect((yield* s3.getBucketVersioning({ Bucket: bucket })).Status).toBe("Enabled");

      const adopted = yield* Alchemist.State.bootstrap(target).pipe(Effect.provide(alchemist));
      expect(adopted.status).toBe("adopted");

      const store = yield* Alchemist.State.store(target).pipe(Effect.provide(alchemist));
      expect(yield* store.listStacks()).toEqual([]);

      // Encrypted at rest with the store's own KMS key.
      const alias = `alias/alchemy-state-${name}`;
      const key = (yield* kms.describeKey({ KeyId: alias })).KeyMetadata;
      const rule = (yield* s3.getBucketEncryption({ Bucket: bucket }))
        .ServerSideEncryptionConfiguration?.Rules?.[0];
      expect(rule?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm).toBe("aws:kms");
      const keyId = rule?.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID;
      expect(Redacted.isRedacted(keyId) ? Redacted.value(keyId) : keyId).toBe(key?.Arn);

      const torn = yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));
      expect(torn.deleted).toEqual([bucket]);
      expect(yield* bucketExists(bucket)).toBe(false);
      // Kept: state stored elsewhere may be sealed under it.
      expect((yield* kms.describeKey({ KeyId: alias })).KeyMetadata?.KeyState).toBe("Enabled");

      const again = yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));
      expect(again.deleted).toEqual([]);

      // In CI, a missing store fails instead of being created on first use.
      const inCi = yield* inCI(
        Effect.exit(
          Alchemist.State.store(target).pipe(
            Effect.flatMap((store) => store.listStacks()),
            Effect.provide(alchemist),
          ),
        ),
      );
      expect(Exit.isFailure(inCi)).toBe(true);
      if (Exit.isFailure(inCi)) {
        expect(Cause.pretty(inCi.cause)).toContain(
          `Run 'alchemy state bootstrap --backend aws-s3 --name ${name}`,
        );
      }
      expect(yield* bucketExists(bucket)).toBe(false);
    }),
  // Exclusive: sets `CI` on the process.
  {
    tags: [
      "provider:aws",
      "provider:aws:s3",
      "provider:aws:kms",
      "provider:aws:statestore",
      "live",
    ],
    timeout: 180_000,
    exclusive: true,
  },
);

test.provider(
  "a store whose key was scheduled for deletion outside alchemy brings it back",
  (stack) =>
    Effect.gen(function* () {
      const name = `recover-${yield* Effect.sync(() =>
        createHash("sha256").update(stack.stage).digest("hex").slice(0, 8),
      )}`;
      const target = { type: "provider", backend: "aws-s3", name } as const;
      const alias = `alias/alchemy-state-${name}`;
      const alchemist = Alchemist.layer();
      const record = {
        resourceType: "test:resource",
        namespace: undefined,
        fqn: "Sealed",
        logicalId: "Sealed",
        instanceId: "instance-Sealed",
        providerVersion: 1,
        status: "created",
        downstream: [],
        bindings: [],
        props: {},
        attr: { password: Redacted.make("hunter2") },
      } as ResourceState;
      const address = { stack: "KeyRecoveryStack", stage: stack.stage, fqn: "Sealed" };

      yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));
      yield* Alchemist.State.bootstrap(target).pipe(Effect.provide(alchemist));
      // Each store in its own scope, which releases its stage lock.
      yield* Effect.scoped(
        Alchemist.State.store(target).pipe(
          Effect.flatMap((store) => store.set({ ...address, value: record })),
          Effect.provide(alchemist),
        ),
      );

      // What `aws kms schedule-key-deletion` (or an account sweep) does.
      const keyId = (yield* kms.describeKey({ KeyId: alias })).KeyMetadata!.KeyId;
      yield* kms.scheduleKeyDeletion({ KeyId: keyId, PendingWindowInDays: 7 });

      // A fresh store cancels the deletion and opens the secret straight away.
      const read = (yield* Effect.scoped(
        Alchemist.State.store(target).pipe(
          Effect.flatMap((store) => store.get(address)),
          Effect.provide(alchemist),
        ),
      )) as ResourceState;
      expect(Redacted.value(read.attr!.password as Redacted.Redacted<string>)).toBe("hunter2");
      expect((yield* kms.describeKey({ KeyId: keyId })).KeyMetadata?.KeyState).toBe("Enabled");

      yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:s3",
      "provider:aws:kms",
      "provider:aws:statestore",
      "live",
    ],
    timeout: 180_000,
  },
);
