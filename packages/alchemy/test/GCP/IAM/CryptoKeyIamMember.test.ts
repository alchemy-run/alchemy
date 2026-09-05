import * as GCP from "@/GCP";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const hasGcpCreds = !!(
  project &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

// Cloud KMS KeyRings cannot be deleted. Reuse the standing test ring.
const KEY_RING_ID = "alchemy-test-keyring";

const keyMembers = (resource: string, role: string) =>
  kms
    .getIamPolicyProjectsLocationsKeyRingsCryptoKeys({
      resource,
      "options.requestedPolicyVersion": 3,
    })
    .pipe(
      Effect.map(
        (policy) =>
          policy.bindings?.find(
            (binding) =>
              binding.role === role && binding.condition === undefined,
          )?.members ?? [],
      ),
    );

test.provider.skipIf(!hasGcpCreds)(
  "grant and revoke a role on a crypto key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ring = yield* GCP.KMS.KeyRing("Keys", {
            keyRingId: KEY_RING_ID,
            location: "us-central1",
          });
          const key = yield* GCP.KMS.CryptoKey("IamMemberKey", {
            keyRing: ring.name,
            skipInitialVersionCreation: true,
          });
          const account = yield* GCP.IAM.ServiceAccount("Decrypter", {
            displayName: "Alchemy crypto key IAM member test",
          });
          const member = yield* GCP.IAM.CryptoKeyIamMember("Decrypt", {
            cryptoKey: key.name,
            role: "roles/cloudkms.cryptoKeyDecrypter",
            member: Output.interpolate`serviceAccount:${account.email}`,
          });
          return { key, account, member };
        }),
      );

      const principal = `serviceAccount:${created.account.email}`;
      expect(created.member.resource).toEqual(created.key.name);
      expect(created.member.role).toEqual("roles/cloudkms.cryptoKeyDecrypter");
      expect(created.member.member).toEqual(principal);
      expect(
        yield* keyMembers(
          created.key.name,
          "roles/cloudkms.cryptoKeyDecrypter",
        ),
      ).toContain(principal);

      // Revoke the grant while keeping the key so the policy can be observed
      // after the member row is deleted.
      const revoked = yield* stack.deploy(
        Effect.gen(function* () {
          const ring = yield* GCP.KMS.KeyRing("Keys", {
            keyRingId: KEY_RING_ID,
            location: "us-central1",
          });
          return yield* GCP.KMS.CryptoKey("IamMemberKey", {
            keyRing: ring.name,
            cryptoKeyId: created.key.cryptoKeyId,
            skipInitialVersionCreation: true,
          });
        }),
      );
      expect(revoked.name).toEqual(created.key.name);
      expect(
        yield* keyMembers(
          created.key.name,
          "roles/cloudkms.cryptoKeyDecrypter",
        ),
      ).not.toContain(principal);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
