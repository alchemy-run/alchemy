import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
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
const KEY_RING_ID = "alchemy-test-keyring";
// Encrypt/decrypt needs a version; versions cannot be deleted for ≥24h, so
// this key is reused across runs (names cannot be reused after delete).
const ENCRYPT_KEY_ID = "alchemy-test-cryptokey-enc";

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

const waitPrimaryEnabled = (name: string) =>
  kms.getProjectsLocationsKeyRingsCryptoKeys({ name }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("500 millis"),
      until: (key) => key.primary?.state === "ENABLED",
      times: 10,
    }),
  );

const ensureEnabledPrimary = (name: string) =>
  Effect.gen(function* () {
    const current = yield* kms.getProjectsLocationsKeyRingsCryptoKeys({
      name,
    });
    const primary = current.primary;
    if (primary?.state === "ENABLED") return;

    if (primary?.state === "DESTROY_SCHEDULED" && primary.name) {
      yield* kms
        .restoreProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
          name: primary.name,
          body: {},
        })
        .pipe(Effect.catchTag("BadRequest", () => Effect.void));
      yield* kms
        .patchProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
          name: primary.name,
          updateMask: "state",
          body: { state: "ENABLED" },
        })
        .pipe(Effect.catchTag("BadRequest", () => Effect.void));
      yield* waitPrimaryEnabled(name);
      return;
    }

    if (primary?.state === "DISABLED" && primary.name) {
      yield* kms.patchProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
        name: primary.name,
        updateMask: "state",
        body: { state: "ENABLED" },
      });
      yield* waitPrimaryEnabled(name);
      return;
    }

    const created =
      yield* kms.createProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
        parent: name,
        body: {},
      });
    if (created.name === undefined) return;
    yield* kms
      .getProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
        name: created.name,
      })
      .pipe(
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (version) => version.state === "ENABLED",
          times: 10,
        }),
      );
    const versionId = created.name.split("/").pop();
    if (versionId !== undefined) {
      yield* kms.updatePrimaryVersionProjectsLocationsKeyRingsCryptoKeys({
        name,
        body: { cryptoKeyVersionId: versionId },
      });
    }
    yield* waitPrimaryEnabled(name);
  });

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

test.provider.skipIf(!hasGcpCreds)(
  "encrypt and decrypt on a standing crypto key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const key = yield* stack.deploy(
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

      expect(key.name).toContain(`/cryptoKeys/${ENCRYPT_KEY_ID}`);
      yield* ensureEnabledPrimary(key.name);

      const plaintext = yield* Effect.sync(() =>
        Buffer.from("alchemy-kms-roundtrip", "utf8").toString("base64"),
      );
      const encrypted = yield* kms.encryptProjectsLocationsKeyRingsCryptoKeys({
        name: key.name,
        body: { plaintext },
      });
      expect(encrypted.ciphertext).toEqual(expect.any(String));

      const decrypted = yield* kms.decryptProjectsLocationsKeyRingsCryptoKeys({
        name: key.name,
        body: { ciphertext: encrypted.ciphertext },
      });
      expect(decrypted.plaintext).toEqual(plaintext);

      yield* stack.destroy();

      // Versions enter DESTROY_SCHEDULED (min 24h). The key remains so the
      // next run can restore the primary rather than leak a new name.
      const stillThere = yield* kms
        .getProjectsLocationsKeyRingsCryptoKeys({ name: key.name })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(stillThere).toEqual("found");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
