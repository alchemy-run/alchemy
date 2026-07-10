import * as AWS from "@/AWS";
import { Volume } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as EC2 from "@distilled.cloud/aws/ec2";
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

test.provider(
  "create an encrypted volume with the standing KMS alias",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

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
      return state === undefined || state === "deleted"
        ? Effect.void
        : Effect.fail(new VolumeStillExists());
    }),
    Effect.retry({
      while: (e) => e instanceof VolumeStillExists,
      schedule: Schedule.exponential(200).pipe(
        Schedule.both(Schedule.recurs(15)),
      ),
    }),
    Effect.catchTag("InvalidVolume.NotFound", () => Effect.void),
  );
});

class VolumeStillExists extends Data.TaggedError("VolumeStillExists") {}
