import { Action } from "@/Action";
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

const KEY_RING_ID = "alchemy-test-keyring";
const ENCRYPT_KEY_ID = "alchemy-test-cryptokey-enc";

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
    if (current.primary?.state === "ENABLED") return;
    if (current.primary?.name) {
      yield* kms
        .restoreProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
          name: current.primary.name,
          body: {},
        })
        .pipe(Effect.catchTag("BadRequest", () => Effect.void));
      yield* kms
        .patchProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
          name: current.primary.name,
          updateMask: "state",
          body: { state: "ENABLED" },
        })
        .pipe(Effect.catchTag("BadRequest", () => Effect.void));
    } else {
      const created =
        yield* kms.createProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
          parent: name,
          body: {},
        });
      const versionId = created.name?.split("/").pop();
      if (created.name && versionId) {
        yield* kms.updatePrimaryVersionProjectsLocationsKeyRingsCryptoKeys({
          name,
          body: { cryptoKeyVersionId: versionId },
        });
      }
    }
    yield* waitPrimaryEnabled(name);
  });

test.provider.skipIf(!hasGcpCreds)(
  "Encrypt and Decrypt round-trip on a standing crypto key",
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
          });
        }),
      );
      yield* ensureEnabledPrimary(key.name);

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const ring = yield* GCP.KMS.KeyRing("Keys", {
            keyRingId: KEY_RING_ID,
            location: "us-central1",
          });
          const cipher = yield* GCP.KMS.CryptoKey("Cipher", {
            keyRing: ring.name,
            cryptoKeyId: ENCRYPT_KEY_ID,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* cipher.name;
              const encrypt = yield* GCP.KMS.Encrypt(cipher);
              const decrypt = yield* GCP.KMS.Decrypt(cipher);
              return Effect.fn(function* () {
                const plaintext = yield* Effect.sync(() =>
                  Buffer.from("alchemy-kms-binding", "utf8").toString("base64"),
                );
                const encrypted = yield* encrypt({ body: { plaintext } });
                const decrypted = yield* decrypt({
                  body: { ciphertext: encrypted.ciphertext },
                });
                return { plaintext, encrypted, decrypted };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(out.encrypted.ciphertext).toEqual(expect.any(String));
      expect(out.decrypted.plaintext).toEqual(out.plaintext);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
