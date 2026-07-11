import * as Lambda from "@/AWS/Lambda";
import * as PaymentCryptography from "@/AWS/PaymentCryptography";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Decoded distilled Sensitive* outputs are Redacted at runtime.
const unwrap = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

// Deterministic IV for the CBC round-trip route (test-only).
const IV = "00000000000000000000000000000000";

export class PaymentCryptographyTestFunction extends Lambda.Function<Lambda.Function>()(
  "PaymentCryptographyTestFunction",
) {}

export default PaymentCryptographyTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const dataKey = yield* PaymentCryptography.Key("DataKey", {
      keyAttributes: {
        keyAlgorithm: "AES_128",
        keyClass: "SYMMETRIC_KEY",
        keyUsage: "TR31_D0_SYMMETRIC_DATA_ENCRYPTION_KEY",
        keyModesOfUse: {
          encrypt: true,
          decrypt: true,
          wrap: true,
          unwrap: true,
        },
      },
    });
    const macKey = yield* PaymentCryptography.Key("MacKey", {
      keyAttributes: {
        keyAlgorithm: "HMAC_SHA256",
        keyClass: "SYMMETRIC_KEY",
        keyUsage: "TR31_M7_HMAC_KEY",
        keyModesOfUse: { generate: true, verify: true },
      },
    });

    const encryptData = yield* PaymentCryptography.EncryptData(dataKey);
    const decryptData = yield* PaymentCryptography.DecryptData(dataKey);
    const generateMac = yield* PaymentCryptography.GenerateMac(macKey);
    const verifyMac = yield* PaymentCryptography.VerifyMac(macKey);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/encrypt-decrypt") {
          const body = (yield* request.json) as unknown as {
            plainTextHex: string;
          };
          const encrypted = yield* encryptData({
            PlainText: body.plainTextHex,
            EncryptionAttributes: {
              Symmetric: { Mode: "CBC", InitializationVector: IV },
            },
          });
          const cipherText = unwrap(encrypted.CipherText);
          const decrypted = yield* decryptData({
            CipherText: cipherText,
            DecryptionAttributes: {
              Symmetric: { Mode: "CBC", InitializationVector: IV },
            },
          });
          return yield* HttpServerResponse.json({
            keyArn: encrypted.KeyArn,
            cipherText,
            plainText: unwrap(decrypted.PlainText),
          });
        }

        if (request.method === "POST" && pathname === "/mac") {
          const body = (yield* request.json) as unknown as {
            messageDataHex: string;
          };
          // The hash function comes from the key's HMAC_SHA256 algorithm;
          // the MAC attribute is plain "HMAC".
          const generated = yield* generateMac({
            MessageData: body.messageDataHex,
            GenerationAttributes: { Algorithm: "HMAC" },
          });
          const mac = unwrap(generated.Mac);
          const verified = yield* verifyMac({
            MessageData: body.messageDataHex,
            Mac: mac,
            VerificationAttributes: { Algorithm: "HMAC" },
          });
          // A tampered MAC must fail with the typed
          // VerificationFailedException.
          const tamperedMac = (mac.startsWith("0") ? "1" : "0") + mac.slice(1);
          const tampered = yield* verifyMac({
            MessageData: body.messageDataHex,
            Mac: tamperedMac,
            VerificationAttributes: { Algorithm: "HMAC" },
          }).pipe(
            Effect.map(() => "verified"),
            Effect.catchTag("VerificationFailedException", () =>
              Effect.succeed("verification-failed"),
            ),
          );
          return yield* HttpServerResponse.json({
            mac,
            verifiedKeyArn: verified.KeyArn,
            tampered,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        PaymentCryptography.EncryptDataHttp,
        PaymentCryptography.DecryptDataHttp,
        PaymentCryptography.GenerateMacHttp,
        PaymentCryptography.VerifyMacHttp,
      ),
    ),
  ),
);
