import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

export const Ring = Stackit.KMS.KeyRing("KmsBindingsRing", {});

/** Crypto round trips and reads only: its first version stays usable. */
export const DataKey = Ring.pipe(
  Effect.flatMap((ring) =>
    Stackit.KMS.Key("KmsBindingsDataKey", {
      keyRingId: ring.keyRingId,
      algorithm: "aes_256_gcm",
      purpose: "symmetric_encrypt_decrypt",
    }),
  ),
);

export const SigningKey = Ring.pipe(
  Effect.flatMap((ring) =>
    Stackit.KMS.Key("KmsBindingsSigningKey", {
      keyRingId: ring.keyRingId,
      algorithm: "ecdsa_p256_sha256",
      purpose: "asymmetric_sign_verify",
    }),
  ),
);

/** Rotated, disabled and destroyed by the manage bindings. */
export const VersionsKey = Ring.pipe(
  Effect.flatMap((ring) =>
    Stackit.KMS.Key("KmsBindingsVersionsKey", {
      keyRingId: ring.keyRingId,
      algorithm: "aes_256_gcm",
      purpose: "symmetric_encrypt_decrypt",
    }),
  ),
);

export const ImportedKey = Ring.pipe(
  Effect.flatMap((ring) =>
    Stackit.KMS.Key("KmsBindingsImportedKey", {
      keyRingId: ring.keyRingId,
      algorithm: "aes_256_gcm",
      purpose: "symmetric_encrypt_decrypt",
      importOnly: true,
    }),
  ),
);

export const Wrapper = Ring.pipe(
  Effect.flatMap((ring) =>
    Stackit.KMS.WrappingKey("KmsBindingsWrapper", {
      keyRingId: ring.keyRingId,
      algorithm: "rsa_2048_oaep_sha256",
      purpose: "wrap_symmetric_key",
    }),
  ),
);

const bytesOf = (text: string) => new TextEncoder().encode(text);

/** Query parameters arrive as base64; a malformed one is a bug in the test. */
const fromBase64 = (value: string) => {
  const decoded = Base64.decode(value);
  return Result.isSuccess(decoded) ? decoded.success : new Uint8Array();
};

/**
 * A Cloudflare Worker with every KMS binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class KmsBindingsWorker extends Cloudflare.Worker<KmsBindingsWorker>()(
  "StackitKmsBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const ring = yield* Ring;
    const dataKey = yield* DataKey;
    const signingKey = yield* SigningKey;
    const versionsKey = yield* VersionsKey;
    const importedKey = yield* ImportedKey;
    const wrapper = yield* Wrapper;

    const encrypt = yield* Stackit.KMS.Encrypt(dataKey);
    const decrypt = yield* Stackit.KMS.Decrypt(dataKey);
    const sign = yield* Stackit.KMS.Sign(signingKey);
    const verify = yield* Stackit.KMS.Verify(signingKey);
    const getKey = yield* Stackit.KMS.GetKey(dataKey);
    const getVersion = yield* Stackit.KMS.GetVersion(signingKey);
    const listVersions = yield* Stackit.KMS.ListVersions(dataKey);
    const getKeyRing = yield* Stackit.KMS.GetKeyRing(ring);
    const listKeys = yield* Stackit.KMS.ListKeys(ring);
    const listKeyRings = yield* Stackit.KMS.ListKeyRings(ring);
    const getWrappingKey = yield* Stackit.KMS.GetWrappingKey(wrapper);
    const listWrappingKeys = yield* Stackit.KMS.ListWrappingKeys(ring);
    const rotateKey = yield* Stackit.KMS.RotateKey(versionsKey);
    const enableVersion = yield* Stackit.KMS.EnableVersion(versionsKey);
    const disableVersion = yield* Stackit.KMS.DisableVersion(versionsKey);
    const destroyVersion = yield* Stackit.KMS.DestroyVersion(versionsKey);
    const restoreVersion = yield* Stackit.KMS.RestoreVersion(versionsKey);
    const importKey = yield* Stackit.KMS.ImportKey(importedKey);
    const readKey = yield* Stackit.KMS.ReadKey(dataKey);
    const writeKey = yield* Stackit.KMS.WriteKey(versionsKey);
    const readWriteKey = yield* Stackit.KMS.ReadWriteKey(versionsKey);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        const versionNumber = () => Number(param("version"));
        switch (url.pathname) {
          case "/encrypt":
            return yield* respond(
              encrypt({ plaintext: Redacted.make(bytesOf(param("text"))) }).pipe(
                Effect.map(({ ciphertext, version }) => ({
                  ciphertext: Base64.encode(ciphertext),
                  version,
                })),
              ),
            );
          case "/decrypt":
            return yield* respond(
              decrypt({
                ciphertext: fromBase64(param("ciphertext")),
                version: versionNumber(),
              }).pipe(
                Effect.map(({ plaintext, version }) => ({
                  redacted: Redacted.isRedacted(plaintext),
                  printed: String(plaintext),
                  text: new TextDecoder().decode(Redacted.value(plaintext)),
                  version,
                })),
              ),
            );
          case "/sign":
            return yield* respond(
              sign({ data: bytesOf(param("text")) }).pipe(
                Effect.map(({ signature, version }) => ({
                  signature: Base64.encode(signature),
                  version,
                })),
              ),
            );
          case "/verify":
            return yield* respond(
              verify({
                data: bytesOf(param("text")),
                signature: fromBase64(param("signature")),
                version: versionNumber(),
              }),
            );
          case "/get-key":
            return yield* respond(getKey());
          case "/get-version":
            return yield* respond(getVersion({ versionNumber: versionNumber() }));
          case "/list-versions":
            return yield* respond(listVersions());
          case "/get-key-ring":
            return yield* respond(getKeyRing());
          case "/list-keys":
            return yield* respond(listKeys());
          case "/list-key-rings":
            return yield* respond(listKeyRings());
          case "/get-wrapping-key":
            return yield* respond(getWrappingKey());
          case "/list-wrapping-keys":
            return yield* respond(listWrappingKeys());
          case "/rotate-key":
            return yield* respond(rotateKey());
          case "/enable-version":
            return yield* respond(enableVersion({ versionNumber: versionNumber() }));
          case "/disable-version":
            return yield* respond(disableVersion({ versionNumber: versionNumber() }));
          case "/destroy-version":
            return yield* respond(destroyVersion({ versionNumber: versionNumber() }));
          case "/restore-version":
            return yield* respond(restoreVersion({ versionNumber: versionNumber() }));
          case "/import-key":
            return yield* respond(
              importKey({
                wrappedKey: Redacted.make(fromBase64(param("wrapped"))),
                wrappingKeyId: param("wrappingKeyId"),
              }),
            );
          case "/read-key":
            return yield* respond(
              Effect.all({
                key: readKey.getKey(),
                version: readKey.getVersion({ versionNumber: versionNumber() }),
                versions: readKey.listVersions(),
              }),
            );
          case "/write-key":
            return yield* respond(writeKey.rotateKey());
          case "/read-write-key":
            return yield* respond(
              Effect.gen(function* () {
                const rotated = yield* readWriteKey.rotateKey();
                const { versions } = yield* readWriteKey.listVersions();
                return { rotated: rotated.number, versions: versions.map((v) => v.number) };
              }),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.KMS.EncryptHttp,
        Stackit.KMS.DecryptHttp,
        Stackit.KMS.SignHttp,
        Stackit.KMS.VerifyHttp,
        Stackit.KMS.GetKeyHttp,
        Stackit.KMS.GetVersionHttp,
        Stackit.KMS.ListVersionsHttp,
        Stackit.KMS.GetKeyRingHttp,
        Stackit.KMS.ListKeysHttp,
        Stackit.KMS.ListKeyRingsHttp,
        Stackit.KMS.GetWrappingKeyHttp,
        Stackit.KMS.ListWrappingKeysHttp,
        Stackit.KMS.RotateKeyHttp,
        Stackit.KMS.EnableVersionHttp,
        Stackit.KMS.DisableVersionHttp,
        Stackit.KMS.DestroyVersionHttp,
        Stackit.KMS.RestoreVersionHttp,
        Stackit.KMS.ImportKeyHttp,
        Stackit.KMS.ReadKeyHttp,
        Stackit.KMS.WriteKeyHttp,
        Stackit.KMS.ReadWriteKeyHttp,
      ),
    ),
  ),
) {}
