import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { KEY_RING_ID, kmsTestId } from "./common.ts";
import * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const project = process.env.GOOGLE_PROJECT_ID ?? "";

// Cloud KMS KeyRings cannot be deleted. Reuse the standing test ring.
// Encrypt/decrypt needs a version; versions cannot be deleted for ≥24h, so
// this key is reused across runs (names cannot be reused after delete).
const ENCRYPT_KEY_ID = kmsTestId("cryptokey");

const waitUntilGone = (name: string) =>
  kms.getProjectsLocationsKeyRingsCryptoKeys({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsKeyRingsCryptoKeys on a missing key fails with NotFound",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kms.getProjectsLocationsKeyRingsCryptoKeys({
          name: `projects/${project}/locations/us-central1/keyRings/${KEY_RING_ID}/cryptoKeys/alchemy-cryptokey-does-not-exist`,
        }),
      );
      expect(error._tag).toBe("NotFound");
    }).pipe(logLevel),
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a crypto key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ring = yield* GCP.KMS.KeyRing("Keys", {
            keyRingId: KEY_RING_ID,
            location: "us-central1",
          });
          return yield* GCP.KMS.CryptoKey("Data", {
            keyRing: ring.name,
            skipInitialVersionCreation: true,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.cryptoKeyId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.project).toEqual(project);
      expect(created.purpose).toEqual("ENCRYPT_DECRYPT");
      expect(created.keyRing).toContain(`/keyRings/${KEY_RING_ID}`);
      expect(created.name).toContain("/cryptoKeys/");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.primaryVersion).toBeUndefined();

      const fetched = yield* kms.getProjectsLocationsKeyRingsCryptoKeys({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.purpose).toEqual("ENCRYPT_DECRYPT");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const ring = yield* GCP.KMS.KeyRing("Keys", {
            keyRingId: KEY_RING_ID,
            location: "us-central1",
          });
          return yield* GCP.KMS.CryptoKey("Data", {
            keyRing: ring.name,
            cryptoKeyId: created.cryptoKeyId,
            skipInitialVersionCreation: true,
            labels: { env: "prod", role: "cmek" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "cmek" });

      const fetchedUpdate = yield* kms.getProjectsLocationsKeyRingsCryptoKeys({
        name: created.name,
      });
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("cmek");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);

const roundTrip = (name: string, text: string) =>
  Effect.gen(function* () {
    const plaintext = yield* Effect.sync(() =>
      Buffer.from(text, "utf8").toString("base64"),
    );
    const { ciphertext } =
      yield* kms.encryptProjectsLocationsKeyRingsCryptoKeys({
        name,
        body: { plaintext },
      });
    const decrypted = yield* kms.decryptProjectsLocationsKeyRingsCryptoKeys({
      name,
      body: { ciphertext },
    });
    return decrypted.plaintext === plaintext;
  });

test.provider.skipIf(!hasGcpCreds)(
  "destroy releases a fixed-id key and the next deploy reclaims it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = stack.deploy(
        Effect.gen(function* () {
          const ring = yield* GCP.KMS.KeyRing("Keys", {
            keyRingId: KEY_RING_ID,
            location: "us-central1",
          });
          return yield* GCP.KMS.CryptoKey("Cipher", {
            keyRing: ring.name,
            cryptoKeyId: ENCRYPT_KEY_ID,
            labels: { env: "test" },
          });
        }),
      );

      const key = yield* deploy;
      expect(key.name).toContain(`/cryptoKeys/${ENCRYPT_KEY_ID}`);
      expect(yield* roundTrip(key.name, "first")).toEqual(true);
      const firstPrimary = (yield* kms.getProjectsLocationsKeyRingsCryptoKeys({
        name: key.name,
      })).primary?.name;

      yield* stack.destroy();

      // KMS keeps the key; Alchemy releases it: every version scheduled for
      // destruction, ownership labels swapped for the released marker.
      const released = yield* kms.getProjectsLocationsKeyRingsCryptoKeys({
        name: key.name,
      });
      expect(released.labels).toEqual({
        env: "test",
        "alchemy-released": "true",
      });
      expect(released.primary?.state).toEqual("DESTROY_SCHEDULED");

      // Redeploying the same id reclaims it with fresh key material.
      const reclaimed = yield* deploy;
      expect(reclaimed.name).toEqual(key.name);
      const live = yield* kms.getProjectsLocationsKeyRingsCryptoKeys({
        name: key.name,
      });
      expect(live.labels?.["alchemy-released"]).toBeUndefined();
      expect(live.labels?.["alchemy-id"]).toEqual("cipher");
      expect(live.primary?.state).toEqual("ENABLED");
      expect(live.primary?.name).not.toEqual(firstPrimary);
      expect(yield* roundTrip(key.name, "second")).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
