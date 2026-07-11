import * as AWS from "@/AWS";
import { Alias, Key } from "@/AWS/PaymentCryptography";
import * as Test from "@/Test/Vitest";
import * as paymentcryptography from "@distilled.cloud/aws/payment-cryptography";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probes: prove the distilled error unions carry the
// not-found tag the provider's read/delete paths depend on. These run in
// every CI pass at near-zero cost, unlike the gated lifecycle below.
test.provider(
  "getKey on a nonexistent identifier fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        paymentcryptography.getKey({
          KeyIdentifier: "alias/alchemy-nonexistent-payment-key-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "getAlias on a nonexistent alias fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        paymentcryptography.getAlias({
          AliasName: "alias/alchemy-nonexistent-payment-alias-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const dataKeyAttributes = {
  keyAlgorithm: "AES_128",
  keyClass: "SYMMETRIC_KEY",
  keyUsage: "TR31_D0_SYMMETRIC_DATA_ENCRYPTION_KEY",
  keyModesOfUse: {
    encrypt: true,
    decrypt: true,
    wrap: true,
    unwrap: true,
  },
} as const;

// Keys bill monthly while they exist, so the live lifecycle is gated behind
// AWS_TEST_PAYMENTCRYPTO=1 and always destroys what it created (with the
// minimum 3-day deletion window).
test.provider.skipIf(!process.env.AWS_TEST_PAYMENTCRYPTO)(
  "create key + alias, toggle enabled, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* Key("DataKey", {
            keyAttributes: dataKeyAttributes,
            tags: { fixture: "payment-cryptography-key" },
          });
          const alias = yield* Alias("DataKeyAlias", { keyArn: key.keyArn });
          return { key, alias };
        }),
      );

      expect(deployed.key.keyArn).toContain(":key/");
      expect(deployed.key.keyState).toBe("CREATE_COMPLETE");
      expect(deployed.key.enabled).toBe(true);
      expect(deployed.key.exportable).toBe(false);
      expect(deployed.key.keyCheckValue).toBeTruthy();
      expect(deployed.alias.aliasName).toMatch(/^alias\//);
      expect(deployed.alias.keyArn).toBe(deployed.key.keyArn);

      // Out-of-band verification via distilled.
      const observed = yield* paymentcryptography.getKey({
        KeyIdentifier: deployed.key.keyArn,
      });
      expect(observed.Key.KeyState).toBe("CREATE_COMPLETE");
      expect(observed.Key.Enabled).toBe(true);
      expect(observed.Key.KeyAttributes.KeyAlgorithm).toBe("AES_128");
      expect(observed.Key.KeyAttributes.KeyUsage).toBe(
        "TR31_D0_SYMMETRIC_DATA_ENCRYPTION_KEY",
      );
      const observedAlias = yield* paymentcryptography.getAlias({
        AliasName: deployed.alias.aliasName,
      });
      expect(observedAlias.Alias.KeyArn).toBe(deployed.key.keyArn);

      // Update in place: disable the key (StopKeyUsage) — same ARN.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* Key("DataKey", {
            keyAttributes: dataKeyAttributes,
            enabled: false,
            tags: { fixture: "payment-cryptography-key", phase: "two" },
          });
          const alias = yield* Alias("DataKeyAlias", { keyArn: key.keyArn });
          return { key, alias };
        }),
      );
      expect(updated.key.keyArn).toBe(deployed.key.keyArn);
      expect(updated.key.enabled).toBe(false);
      const observedDisabled = yield* paymentcryptography.getKey({
        KeyIdentifier: deployed.key.keyArn,
      });
      expect(observedDisabled.Key.Enabled).toBe(false);

      // Destroy — the key schedules deletion (DELETE_PENDING) and the alias
      // is removed immediately.
      yield* stack.destroy();
      const stateAfter = yield* paymentcryptography
        .getKey({ KeyIdentifier: deployed.key.keyArn })
        .pipe(
          Effect.map((r) => r.Key.KeyState),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed("gone" as const),
          ),
        );
      expect(["DELETE_PENDING", "DELETE_COMPLETE", "gone"]).toContain(
        stateAfter,
      );
      const aliasError = yield* Effect.flip(
        paymentcryptography.getAlias({
          AliasName: deployed.alias.aliasName,
        }),
      );
      expect(aliasError._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 120_000 },
);
