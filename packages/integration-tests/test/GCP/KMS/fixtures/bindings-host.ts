import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { probeParam, serveProbes } from "../../bindingHost.ts";
import { KEY_RING_ID, kmsTestId } from "../common.ts";

/** Key ring every fixture key lives in; the key-ring bindings are granted on it. */
export const Keys = GCP.KMS.KeyRing("Keys", {
  keyRingId: KEY_RING_ID,
  location: "us-central1",
});

const key = (id: string, props: Omit<GCP.KMS.CryptoKeyProps, "keyRing" | "cryptoKeyId"> = {}) =>
  Effect.gen(function* () {
    const ring = yield* Keys;
    return yield* GCP.KMS.CryptoKey(id, {
      ...props,
      keyRing: ring.name,
      cryptoKeyId: kmsTestId(`binding-${id.toLowerCase()}`),
    });
  });

/** Key the bindings are granted on (roles/cloudkms.cryptoKey{En,De}crypter). */
export const Cipher = Effect.gen(function* () {
  const ring = yield* Keys;
  return yield* GCP.KMS.CryptoKey("Cipher", {
    keyRing: ring.name,
    cryptoKeyId: kmsTestId("binding"),
  });
});

/** Symmetric key whose versions the version-management bindings drive. */
export const Versions = key("Versions");
export const Signer = key("Signer", {
  purpose: "ASYMMETRIC_SIGN",
  versionTemplate: { algorithm: "EC_SIGN_P256_SHA256" },
});
export const Unwrapper = key("Unwrapper", {
  purpose: "ASYMMETRIC_DECRYPT",
  versionTemplate: { algorithm: "RSA_DECRYPT_OAEP_2048_SHA256" },
});
export const Mac = key("Mac", {
  purpose: "MAC",
  versionTemplate: { algorithm: "HMAC_SHA256" },
});
export const Raw = key("Raw", {
  purpose: "RAW_ENCRYPT_DECRYPT",
  versionTemplate: { algorithm: "AES_256_GCM" },
});
export const Kem = key("Kem", {
  purpose: "KEY_ENCAPSULATION",
  versionTemplate: { algorithm: "ML_KEM_768" },
});

export const Wrap = Effect.gen(function* () {
  const ring = yield* Keys;
  return yield* GCP.KMS.ImportJob("Wrap", {
    keyRing: ring.name,
    importJobId: kmsTestId("binding-wrap"),
    importMethod: "RSA_OAEP_3072_SHA256_AES_256",
    protectionLevel: "SOFTWARE",
  });
});

/** A typed failure as `{ _tag }`, so a probe can report it as a value. */
const failureTag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.result(effect).pipe(
    Effect.map((result) => (Result.isFailure(result) ? result.failure._tag : "succeeded")),
  );

/**
 * Effect-native Cloud Run service exercising every KMS binding as its own
 * runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class KmsBindingsHost extends GCP.Function<KmsBindingsHost>()(
  "KmsBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const encrypt = yield* GCP.KMS.Encrypt(Cipher);
    const decrypt = yield* GCP.KMS.Decrypt(Cipher);
    const plaintext = btoa("alchemy-kms-binding");

    const getKeyRing = yield* GCP.KMS.GetKeyRing(Keys);
    const listCryptoKeys = yield* GCP.KMS.ListKeyRingCryptoKeys(Keys);
    const listImportJobs = yield* GCP.KMS.ListKeyRingImportJobs(Keys);
    const getImportJob = yield* GCP.KMS.GetImportJob(Wrap);

    const getCryptoKey = yield* GCP.KMS.GetCryptoKey(Versions);
    const createVersion = yield* GCP.KMS.CreateCryptoKeyVersion(Versions);
    const listVersions = yield* GCP.KMS.ListCryptoKeyVersions(Versions);
    const getVersion = yield* GCP.KMS.GetCryptoKeyVersion(Versions);
    const patchVersion = yield* GCP.KMS.PatchCryptoKeyVersion(Versions);
    const updatePrimary = yield* GCP.KMS.UpdateCryptoKeyPrimaryVersion(Versions);
    const destroyVersion = yield* GCP.KMS.DestroyCryptoKeyVersion(Versions);
    const restoreVersion = yield* GCP.KMS.RestoreCryptoKeyVersion(Versions);
    const deleteVersion = yield* GCP.KMS.DeleteCryptoKeyVersion(Versions);

    const signerPublicKey = yield* GCP.KMS.GetPublicKey(Signer);
    const sign = yield* GCP.KMS.AsymmetricSign(Signer);
    const unwrapperPublicKey = yield* GCP.KMS.GetPublicKey(Unwrapper);
    const asymmetricDecrypt = yield* GCP.KMS.AsymmetricDecrypt(Unwrapper);
    const macSign = yield* GCP.KMS.MacSign(Mac);
    const macVerify = yield* GCP.KMS.MacVerify(Mac);
    const rawEncrypt = yield* GCP.KMS.RawEncrypt(Raw);
    const rawDecrypt = yield* GCP.KMS.RawDecrypt(Raw);
    const decapsulate = yield* GCP.KMS.Decapsulate(Kem);

    const version = probeParam("version");

    return {
      fetch: serveProbes({
        roundTrip: Effect.gen(function* () {
          const encrypted = yield* encrypt({ body: { plaintext } });
          const decrypted = yield* decrypt({
            body: { ciphertext: encrypted.ciphertext },
          });
          return {
            plaintext,
            ciphertext: encrypted.ciphertext,
            decrypted: decrypted.plaintext,
          };
        }),
        keyRing: Effect.all({
          ring: getKeyRing(),
          keys: listCryptoKeys(),
          importJobs: listImportJobs(),
          importJob: getImportJob(),
        }),
        getCryptoKey: getCryptoKey(),
        createVersion: createVersion({ body: {} }),
        listVersions: listVersions(),
        getVersion: Effect.flatMap(version, (cryptoKeyVersion) => getVersion({ cryptoKeyVersion })),
        updatePrimary: Effect.flatMap(version, (cryptoKeyVersionId) =>
          updatePrimary({ body: { cryptoKeyVersionId } }),
        ),
        disableVersion: Effect.flatMap(version, (cryptoKeyVersion) =>
          patchVersion({ cryptoKeyVersion, updateMask: "state", body: { state: "DISABLED" } }),
        ),
        destroyVersion: Effect.flatMap(version, (cryptoKeyVersion) =>
          destroyVersion({ cryptoKeyVersion, body: {} }),
        ),
        restoreVersion: Effect.flatMap(version, (cryptoKeyVersion) =>
          restoreVersion({ cryptoKeyVersion, body: {} }),
        ),
        // Only versions whose generation or import failed can be deleted.
        deleteVersion: Effect.flatMap(version, (cryptoKeyVersion) =>
          failureTag(deleteVersion({ cryptoKeyVersion })),
        ),
        sign: Effect.gen(function* () {
          const cryptoKeyVersion = yield* version;
          const digest = yield* probeParam("digest");
          const publicKey = yield* signerPublicKey({ cryptoKeyVersion });
          const signed = yield* sign({
            cryptoKeyVersion,
            body: { digest: { sha256: digest } },
          });
          return { pem: publicKey.pem, signature: signed.signature };
        }),
        unwrapperPublicKey: Effect.flatMap(version, (cryptoKeyVersion) =>
          unwrapperPublicKey({ cryptoKeyVersion }),
        ),
        asymmetricDecrypt: Effect.gen(function* () {
          const cryptoKeyVersion = yield* version;
          const ciphertext = yield* probeParam("ciphertext");
          return yield* asymmetricDecrypt({ cryptoKeyVersion, body: { ciphertext } });
        }),
        mac: Effect.gen(function* () {
          const cryptoKeyVersion = yield* version;
          const data = btoa("alchemy-mac");
          const { mac } = yield* macSign({ cryptoKeyVersion, body: { data } });
          const valid = yield* macVerify({ cryptoKeyVersion, body: { data, mac } });
          const tampered = yield* macVerify({
            cryptoKeyVersion,
            body: { data: btoa("tampered"), mac },
          });
          return { valid: valid.success, tampered: tampered.success ?? false };
        }),
        raw: Effect.gen(function* () {
          const cryptoKeyVersion = yield* version;
          const additionalAuthenticatedData = btoa("aad");
          const encrypted = yield* rawEncrypt({
            cryptoKeyVersion,
            body: { plaintext, additionalAuthenticatedData },
          });
          const decrypted = yield* rawDecrypt({
            cryptoKeyVersion,
            body: {
              ciphertext: encrypted.ciphertext,
              initializationVector: encrypted.initializationVector,
              tagLength: encrypted.tagLength,
              additionalAuthenticatedData,
            },
          });
          return { plaintext, decrypted: decrypted.plaintext };
        }),
        // Encapsulating needs an ML-KEM client; a malformed ciphertext proves
        // the call is authorized and reaches the key.
        decapsulate: Effect.flatMap(version, (cryptoKeyVersion) =>
          failureTag(
            decapsulate({
              cryptoKeyVersion,
              body: { ciphertext: btoa("not-a-kem-ciphertext") },
            }),
          ),
        ),
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        GCP.KMS.EncryptHttp,
        GCP.KMS.DecryptHttp,
        GCP.KMS.GetKeyRingHttp,
        GCP.KMS.ListKeyRingCryptoKeysHttp,
        GCP.KMS.ListKeyRingImportJobsHttp,
        GCP.KMS.GetImportJobHttp,
        GCP.KMS.GetCryptoKeyHttp,
        GCP.KMS.CreateCryptoKeyVersionHttp,
        GCP.KMS.ListCryptoKeyVersionsHttp,
        GCP.KMS.GetCryptoKeyVersionHttp,
        GCP.KMS.PatchCryptoKeyVersionHttp,
        GCP.KMS.UpdateCryptoKeyPrimaryVersionHttp,
        GCP.KMS.DestroyCryptoKeyVersionHttp,
        GCP.KMS.RestoreCryptoKeyVersionHttp,
        GCP.KMS.DeleteCryptoKeyVersionHttp,
        GCP.KMS.GetPublicKeyHttp,
        GCP.KMS.AsymmetricSignHttp,
        GCP.KMS.AsymmetricDecryptHttp,
        GCP.KMS.MacSignHttp,
        GCP.KMS.MacVerifyHttp,
        GCP.KMS.RawEncryptHttp,
        GCP.KMS.RawDecryptHttp,
        GCP.KMS.DecapsulateHttp,
      ),
    ),
  ),
) {}
