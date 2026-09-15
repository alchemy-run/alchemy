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
// Versions enter DESTROY_SCHEDULED for ≥24h, so reuse a standing key.
const CRYPTO_KEY_ID = "alchemy-test-cryptokey-ver";

const waitUntilGone = (name: string) =>
  kms.getProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitVersionReady = (name: string) =>
  kms.getProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({ name }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("500 millis"),
      until: (version) =>
        version.state === "ENABLED" || version.state === "DISABLED",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions on a missing version fails with NotFound",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kms.getProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
          name: `projects/${project}/locations/us-central1/keyRings/${KEY_RING_ID}/cryptoKeys/${CRYPTO_KEY_ID}/cryptoKeyVersions/999999`,
        }),
      );
      expect(error._tag).toBe("NotFound");
    }).pipe(logLevel),
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and destroy a crypto key version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ring = yield* GCP.KMS.KeyRing("Keys", {
            keyRingId: KEY_RING_ID,
            location: "us-central1",
          });
          const key = yield* GCP.KMS.CryptoKey("Data", {
            keyRing: ring.name,
            cryptoKeyId: CRYPTO_KEY_ID,
            skipInitialVersionCreation: true,
            labels: { env: "test" },
          });
          return yield* GCP.KMS.CryptoKeyVersion("V1", {
            cryptoKey: key.name,
          });
        }),
      );

      expect(created.cryptoKeyVersionId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.project).toEqual(project);
      expect(created.cryptoKey).toContain(`/cryptoKeys/${CRYPTO_KEY_ID}`);
      expect(created.name).toContain("/cryptoKeyVersions/");
      expect(["ENABLED", "PENDING_GENERATION"]).toContain(created.state);

      yield* waitVersionReady(created.name);

      const fetched =
        yield* kms.getProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.state).toEqual("ENABLED");

      const disabled = yield* stack.deploy(
        Effect.gen(function* () {
          const ring = yield* GCP.KMS.KeyRing("Keys", {
            keyRingId: KEY_RING_ID,
            location: "us-central1",
          });
          const key = yield* GCP.KMS.CryptoKey("Data", {
            keyRing: ring.name,
            cryptoKeyId: CRYPTO_KEY_ID,
            skipInitialVersionCreation: true,
            labels: { env: "test" },
          });
          return yield* GCP.KMS.CryptoKeyVersion("V1", {
            cryptoKey: key.name,
            cryptoKeyVersionId: created.cryptoKeyVersionId,
            state: "DISABLED",
          });
        }),
      );
      expect(disabled.name).toEqual(created.name);
      expect(disabled.state).toEqual("DISABLED");

      const fetchedDisabled =
        yield* kms.getProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
          name: created.name,
        });
      expect(fetchedDisabled.state).toEqual("DISABLED");

      const enabled = yield* stack.deploy(
        Effect.gen(function* () {
          const ring = yield* GCP.KMS.KeyRing("Keys", {
            keyRingId: KEY_RING_ID,
            location: "us-central1",
          });
          const key = yield* GCP.KMS.CryptoKey("Data", {
            keyRing: ring.name,
            cryptoKeyId: CRYPTO_KEY_ID,
            skipInitialVersionCreation: true,
            labels: { env: "test" },
          });
          return yield* GCP.KMS.CryptoKeyVersion("V1", {
            cryptoKey: key.name,
            cryptoKeyVersionId: created.cryptoKeyVersionId,
            state: "ENABLED",
          });
        }),
      );
      expect(enabled.name).toEqual(created.name);
      expect(enabled.state).toEqual("ENABLED");

      yield* stack.destroy();

      const afterDestroy = yield* kms
        .getProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
          name: created.name,
        })
        .pipe(
          Effect.map((version) => version.state ?? "found"),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(["DESTROY_SCHEDULED", "DESTROYED", "gone"]).toContain(
        afterDestroy,
      );

      const gone = yield* waitUntilGone(
        `projects/${project}/locations/us-central1/keyRings/${KEY_RING_ID}/cryptoKeys/${CRYPTO_KEY_ID}/cryptoKeyVersions/999999`,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
