import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as paymentcryptography from "@distilled.cloud/aws/payment-cryptography";
import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: AWS.providers() });

const unwrap = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const IV = "00000000000000000000000000000000";

const keyAttributes = {
  KeyAlgorithm: "AES_128",
  KeyClass: "SYMMETRIC_KEY",
  KeyUsage: "TR31_D0_SYMMETRIC_DATA_ENCRYPTION_KEY",
  KeyModesOfUse: {
    Encrypt: true,
    Decrypt: true,
    Wrap: true,
    Unwrap: true,
    Generate: false,
    Sign: false,
    Verify: false,
    DeriveKey: false,
    NoRestrictions: false,
  },
} as const;

test.provider.skipIf(!process.env.AWS_TEST_PAYMENTCRYPTO)(
  "probe: reEncryptData raw error",
  () =>
    Effect.gen(function* () {
      const k1 = yield* paymentcryptography
        .createKey({ KeyAttributes: keyAttributes, Exportable: false })
        .pipe(Effect.map((r) => r.Key.KeyArn));
      const k2 = yield* paymentcryptography
        .createKey({ KeyAttributes: keyAttributes, Exportable: false })
        .pipe(Effect.map((r) => r.Key.KeyArn));

      const cleanup = Effect.gen(function* () {
        for (const arn of [k1, k2]) {
          yield* paymentcryptography
            .deleteKey({ KeyIdentifier: arn, DeleteKeyInDays: 3 })
            .pipe(Effect.catchCause(() => Effect.void));
        }
      });

      yield* Effect.gen(function* () {
        const encrypted = yield* paymentcryptographydata.encryptData({
          KeyIdentifier: k1,
          PlainText: "41424344414243444142434441424344",
          EncryptionAttributes: {
            Symmetric: { Mode: "CBC", InitializationVector: IV },
          },
        });
        const result = yield* paymentcryptographydata
          .reEncryptData({
            IncomingKeyIdentifier: k1,
            OutgoingKeyIdentifier: k2,
            CipherText: unwrap(encrypted.CipherText),
            IncomingEncryptionAttributes: {
              Symmetric: { Mode: "CBC", InitializationVector: IV },
            },
            OutgoingEncryptionAttributes: {
              Symmetric: { Mode: "CBC", InitializationVector: IV },
            },
          })
          .pipe(Effect.result);
        yield* Effect.sync(() => {
          if (result._tag !== "Success") {
            throw new Error(
              `REENCRYPT FAILED >>> ${JSON.stringify(result)} <<<`,
            );
          }
        });
        expect(result._tag).toBe("Success");
      }).pipe(Effect.ensuring(cleanup));
    }),
  { timeout: 60_000 },
);
