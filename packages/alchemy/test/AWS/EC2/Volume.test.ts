import * as AWS from "@/AWS";
import { Volume } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as kms from "@distilled.cloud/aws/kms";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The testing account is in us-west-2.
const AZ = "us-west-2a";

test.provider(
  "create, verify, and delete a gp3 volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const volume = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Volume("TestGp3Volume", {
            availabilityZone: AZ,
            size: 1,
            volumeType: "gp3",
          });
        }),
      );

      expect(volume.volumeId).toMatch(/^vol-/);
      expect(volume.availabilityZone).toBe(AZ);
      expect(volume.volumeType).toBe("gp3");
      expect(volume.size).toBe(1);

      // Out-of-band verification.
      const observed = yield* EC2.describeVolumes({
        VolumeIds: [volume.volumeId],
      });
      const v = observed.Volumes?.[0];
      expect(v?.VolumeType).toBe("gp3");
      expect(v?.Size).toBe(1);
      expect(v?.AvailabilityZone).toBe(AZ);
      expect(v?.State === "available" || v?.State === "creating").toBe(true);

      // list() enumerates the deployed volume.
      const provider = yield* Provider.findProvider(Volume);
      const all = yield* provider.list();
      expect(all.some((x) => x.volumeId === volume.volumeId)).toBe(true);

      yield* stack.destroy();
      yield* assertVolumeDeleted(volume.volumeId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// The standing test key shared with test/AWS/KMS ($1/mo, 7-day deletion
// window — never created/deleted per run). An account nuke can remove it or
// leave it pending deletion, which makes encrypted-volume creation fail
// asynchronously (the volume silently transitions to error/deleted), so heal
// it before deploying.
const STANDING_KEY_ALIAS = "alias/alchemy-test-bindings";

const ensureStandingKey = Effect.gen(function* () {
  const existing = yield* kms.describeKey({ KeyId: STANDING_KEY_ALIAS }).pipe(
    Effect.map((response) => response.KeyMetadata),
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
  );

  if (existing?.KeyId) {
    if (existing.KeyState === "PendingDeletion") {
      yield* kms.cancelKeyDeletion({ KeyId: existing.KeyId });
      yield* kms.enableKey({ KeyId: existing.KeyId });
    } else if (existing.Enabled === false) {
      yield* kms.enableKey({ KeyId: existing.KeyId });
    }
    return existing.KeyId;
  }

  const created = yield* kms.createKey({
    Description:
      "Standing key for alchemy AWS binding tests — never deleted (see test/AWS/KMS/Bindings.test.ts)",
    Tags: [{ TagKey: "alchemy:standing-fixture", TagValue: "kms-bindings" }],
  });
  const keyId = created.KeyMetadata?.KeyId;
  if (!keyId) {
    return yield* Effect.die(new Error("createKey returned no key ID"));
  }
  yield* kms
    .createAlias({ AliasName: STANDING_KEY_ALIAS, TargetKeyId: keyId })
    .pipe(
      Effect.catchTag("AlreadyExistsException", () =>
        // Lost a create race with a parallel run: schedule ours for deletion
        // so it doesn't become a $1/mo orphan.
        kms
          .scheduleKeyDeletion({ KeyId: keyId, PendingWindowInDays: 7 })
          .pipe(Effect.ignore),
      ),
    );
  const described = yield* kms.describeKey({ KeyId: STANDING_KEY_ALIAS });
  return described.KeyMetadata!.KeyId;
});

test.provider(
  "create an encrypted volume with the standing KMS alias",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* ensureStandingKey;

      const volume = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Volume("TestEncryptedVolume", {
            availabilityZone: AZ,
            size: 1,
            volumeType: "gp3",
            encrypted: true,
            // A standing KMS key that never gets created/deleted by tests.
            kmsKeyId: "alias/alchemy-test-bindings",
          });
        }),
      );

      expect(volume.encrypted).toBe(true);

      const observed = yield* EC2.describeVolumes({
        VolumeIds: [volume.volumeId],
      });
      const v = observed.Volumes?.[0];
      expect(v?.Encrypted).toBe(true);
      expect(v?.KmsKeyId).toBeDefined();

      yield* stack.destroy();
      yield* assertVolumeDeleted(volume.volumeId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

const assertVolumeDeleted = Effect.fn(function* (volumeId: string) {
  yield* EC2.describeVolumes({ VolumeIds: [volumeId] }).pipe(
    Effect.flatMap((result) => {
      const state = result.Volumes?.[0]?.State;
      // `deleting` is terminal — EC2 can keep a deleted volume visible in
      // this state for many minutes of internal bookkeeping.
      return state === undefined || state === "deleted" || state === "deleting"
        ? Effect.void
        : Effect.fail(new VolumeStillExists());
    }),
    Effect.retry({
      while: (e) => e instanceof VolumeStillExists,
      schedule: Schedule.max([Schedule.exponential(200), Schedule.recurs(15)]),
    }),
    Effect.catchTag("InvalidVolume.NotFound", () => Effect.void),
  );
});

class VolumeStillExists extends Data.TaggedError("VolumeStillExists") {}
