import * as AWS from "@/AWS";
import * as kms from "@distilled.cloud/aws/kms";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Standing test key alias — see the header comment in `Bindings.test.ts`.
 * The key behind this alias is created once (out-of-band, by the test's
 * `beforeAll`) and is NEVER scheduled for deletion: KMS keys cost $1/mo each
 * and carry a 7-day minimum pending-deletion window, so create-and-delete
 * per run is forbidden.
 */
export const STANDING_KEY_ALIAS = "alias/alchemy-test-bindings" as const;

export class KMSTestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "KMSTestFunction",
) {}

const fromBase64 = (value: string) =>
  Effect.sync(() => new Uint8Array(Buffer.from(value, "base64")));

const toBase64 = (value: Uint8Array) =>
  Effect.sync(() => Buffer.from(value).toString("base64"));

const unwrapPlaintext = (
  value: Uint8Array | Redacted.Redacted<Uint8Array> | undefined,
): Uint8Array | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

export default KMSTestFunction.make(
  {
    main: import.meta.url,
    url: true,
  },
  Effect.gen(function* () {
    const encrypt = yield* AWS.KMS.Encrypt(STANDING_KEY_ALIAS);
    const decrypt = yield* AWS.KMS.Decrypt(STANDING_KEY_ALIAS);
    const generateDataKey = yield* AWS.KMS.GenerateDataKey(STANDING_KEY_ALIAS);
    // Deliberately NOT a binding: used by /unauthorized to prove the Lambda
    // role received ONLY the three bound kms actions (least privilege).
    const describeKey = yield* kms.describeKey;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/ready") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/encrypt") {
          const body = (yield* request.json) as {
            plaintextBase64: string;
            context?: Record<string, string>;
          };
          const result = yield* encrypt({
            Plaintext: yield* fromBase64(body.plaintextBase64),
            EncryptionContext: body.context,
          });
          return yield* HttpServerResponse.json({
            keyId: result.KeyId,
            ciphertextBase64: result.CiphertextBlob
              ? yield* toBase64(result.CiphertextBlob)
              : undefined,
          });
        }

        if (request.method === "POST" && pathname === "/decrypt") {
          const body = (yield* request.json) as {
            ciphertextBase64: string;
            context?: Record<string, string>;
          };
          const ciphertext = yield* fromBase64(body.ciphertextBase64);
          const result = yield* decrypt({
            CiphertextBlob: ciphertext,
            EncryptionContext: body.context,
          }).pipe(
            Effect.match({
              onFailure: (error) => ({
                ok: false as const,
                error: error._tag,
              }),
              onSuccess: (response) => ({
                ok: true as const,
                keyId: response.KeyId,
                plaintext: unwrapPlaintext(response.Plaintext),
              }),
            }),
          );
          if (!result.ok) {
            return yield* HttpServerResponse.json(result);
          }
          return yield* HttpServerResponse.json({
            ok: true,
            keyId: result.keyId,
            plaintextBase64: result.plaintext
              ? yield* toBase64(result.plaintext)
              : undefined,
          });
        }

        if (request.method === "POST" && pathname === "/generate-data-key") {
          const result = yield* generateDataKey({ KeySpec: "AES_256" });
          const plaintext = unwrapPlaintext(result.Plaintext);
          return yield* HttpServerResponse.json({
            keyId: result.KeyId,
            plaintextBase64: plaintext ? yield* toBase64(plaintext) : undefined,
            ciphertextBase64: result.CiphertextBlob
              ? yield* toBase64(result.CiphertextBlob)
              : undefined,
          });
        }

        if (request.method === "GET" && pathname === "/unauthorized") {
          // kms:DescribeKey is not bound — the role must reject this call.
          const result = yield* describeKey({
            KeyId: STANDING_KEY_ALIAS,
          }).pipe(
            Effect.match({
              onFailure: (error) => ({
                ok: false as const,
                error: error._tag,
              }),
              onSuccess: () => ({ ok: true as const }),
            }),
          );
          return yield* HttpServerResponse.json(result);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.KMS.DecryptHttp,
        AWS.KMS.EncryptHttp,
        AWS.KMS.GenerateDataKeyHttp,
      ),
    ),
  ),
);
