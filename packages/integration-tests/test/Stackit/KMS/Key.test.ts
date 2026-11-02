import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as kms from "@distilled.cloud/stackit/kms";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  expectKeyPendingDeletion,
  isPendingDeletion,
  observeKey,
  ringRequest,
  slow,
} from "./kms.ts";

const { test } = makeStackitTest();

// Every case creates at least one billed key version: see `kms.ts`.
const options = { tags: stackitTags("kms", "key"), timeout: 300_000 } as const;

/** A generated-name ring and one key in it. */
const keyInRing = (ringId: string, keyId: string, props: Partial<Stackit.KMS.KeyProps> = {}) =>
  Effect.gen(function* () {
    const ring = yield* Stackit.KMS.KeyRing(ringId, {});
    const key = yield* Stackit.KMS.Key(keyId, {
      keyRingId: ring.keyRingId,
      algorithm: "aes_256_gcm",
      purpose: "symmetric_encrypt_decrypt",
      ...props,
    });
    return { ring, key };
  });

test.provider.skipIf(slow)(
  "create a key and schedule its deletion",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const props = { description: "alchemy test key" };
      const { ring, key } = yield* stack.deploy(keyInRing("BasicKeyRing", "BasicKey", props));

      expect(key.keyRingId).toEqual(ring.keyRingId);
      expect(key.projectId).toEqual(projectId);
      expect(key.region).toEqual(region);
      expect(key.state).toEqual("active");
      expect(key.algorithm).toEqual("aes_256_gcm");
      expect(key.purpose).toEqual("symmetric_encrypt_decrypt");
      expect(key.protection).toEqual("software");
      expect(key.accessScope).toEqual("PUBLIC");
      expect(key.importOnly).toEqual(false);
      expect(key.deletionDate).toBeUndefined();
      expect(key.latestVersion).toEqual(1);

      // Out of band: the key and its first version exist.
      const request = { ...ringRequest(scope, ring.keyRingId), keyId: key.keyId };
      const fetched = yield* kms.getKey(request);
      expect(fetched.displayName).toEqual(key.displayName);
      expect(fetched.description).toEqual("alchemy test key");
      const { versions } = yield* kms.listVersions(request);
      expect(versions.map((version) => version.number)).toEqual([1]);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(keyInRing("BasicKeyRing", "BasicKey", props));
      expect(plan.resources.BasicKey).toMatchObject({ action: "noop" });

      yield* stack.destroy();

      // Deletion is scheduled, and the ring is left behind with it.
      yield* expectKeyPendingDeletion(scope, ring.keyRingId, key.keyId);
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "one key per purpose",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const keys = yield* stack.deploy(
        Effect.gen(function* () {
          const ring = yield* Stackit.KMS.KeyRing("PurposeRing", {});
          const keyRingId = ring.keyRingId;
          return {
            encrypt: yield* Stackit.KMS.Key("PurposeEncrypt", {
              keyRingId,
              algorithm: "rsa_2048_oaep_sha256",
              purpose: "asymmetric_encrypt_decrypt",
            }),
            mac: yield* Stackit.KMS.Key("PurposeMac", {
              keyRingId,
              algorithm: "hmac_sha256",
              purpose: "message_authentication_code",
            }),
            sign: yield* Stackit.KMS.Key("PurposeSign", {
              keyRingId,
              algorithm: "ecdsa_p256_sha256",
              purpose: "asymmetric_sign_verify",
            }),
          };
        }),
      );

      for (const key of [keys.encrypt, keys.mac, keys.sign]) {
        const fetched = yield* kms.getKey({
          ...ringRequest(scope, key.keyRingId),
          keyId: key.keyId,
        });
        expect(fetched.purpose).toEqual(key.purpose);
        expect(fetched.algorithm).toEqual(key.algorithm);
        expect(fetched.state).toEqual("active");
      }

      // An asymmetric key publishes its public key; a MAC key doesn't have one.
      const signing = yield* kms.getVersion({
        ...ringRequest(scope, keys.sign.keyRingId),
        keyId: keys.sign.keyId,
        versionNumber: keys.sign.latestVersion!,
      });
      expect(signing.publicKey?.length ?? 0).toBeGreaterThan(0);

      yield* stack.destroy();

      for (const key of [keys.encrypt, keys.mac, keys.sign]) {
        yield* expectKeyPendingDeletion(scope, key.keyRingId, key.keyId);
      }
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "an import-only key starts without a version",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const { key } = yield* stack.deploy(
        keyInRing("ImportOnlyRing", "ImportOnlyKey", { importOnly: true }),
      );
      expect(key.state).toEqual("no_version");
      expect(key.importOnly).toEqual(true);
      expect(key.latestVersion).toBeUndefined();

      const { versions } = yield* kms.listVersions({
        ...ringRequest(scope, key.keyRingId),
        keyId: key.keyId,
      });
      expect(versions).toEqual([]);

      yield* stack.destroy();
      yield* expectKeyPendingDeletion(scope, key.keyRingId, key.keyId);
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "replacing a generated-name key creates the new key first",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const first = yield* stack.deploy(keyInRing("ReplaceKeyRing", "ReplaceKey"));

      const props = { description: "replaced" };
      const plan = yield* stack.plan(keyInRing("ReplaceKeyRing", "ReplaceKey", props));
      expect(plan.resources.ReplaceKey).toMatchObject({ action: "replace" });

      const second = yield* stack.deploy(keyInRing("ReplaceKeyRing", "ReplaceKey", props));
      expect(second.ring.keyRingId).toEqual(first.ring.keyRingId);
      expect(second.key.keyId).not.toEqual(first.key.keyId);
      expect(second.key.displayName).not.toEqual(first.key.displayName);

      // The new generation is live, and the old one is the one scheduled.
      const live = yield* observeKey(scope, second.key.keyRingId, second.key.keyId);
      expect(isPendingDeletion(live)).toBe(false);
      yield* expectKeyPendingDeletion(scope, first.key.keyRingId, first.key.keyId);

      yield* stack.destroy();
      yield* expectKeyPendingDeletion(scope, second.key.keyRingId, second.key.keyId);
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "replacing an explicit-name key never reclaims the live generation",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const displayName = "alchemy-test-kms-named-key";
      const first = yield* stack.deploy(
        keyInRing("NamedKeyRing", "NamedKey", { displayName, description: "first" }),
      );
      expect(first.key.displayName).toEqual(displayName);

      const second = yield* stack.deploy(
        keyInRing("NamedKeyRing", "NamedKey", { displayName, description: "second" }),
      );
      expect(second.key.displayName).toEqual(displayName);
      expect(second.key.description).toEqual("second");
      expect(second.key.keyId).not.toEqual(first.key.keyId);

      // The old key is pending, and the new one stayed out of garbage collection.
      yield* expectKeyPendingDeletion(scope, first.key.keyRingId, first.key.keyId);
      const live = yield* observeKey(scope, second.key.keyRingId, second.key.keyId);
      expect(isPendingDeletion(live)).toBe(false);

      // A later deploy keeps it: state records the new generation.
      const plan = yield* stack.plan(
        keyInRing("NamedKeyRing", "NamedKey", { displayName, description: "second" }),
      );
      expect(plan.resources.NamedKey).toMatchObject({ action: "noop" });

      yield* stack.destroy();
      yield* expectKeyPendingDeletion(scope, second.key.keyRingId, second.key.keyId);
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "a redeploy after destroy creates new keys and doesn't restore the old one",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const first = yield* stack.deploy(keyInRing("RedeployRing", "RedeployKey"));
      yield* stack.destroy();
      yield* expectKeyPendingDeletion(scope, first.key.keyRingId, first.key.keyId);

      // Same logical ids, new generation: the left-behind ring and the pending
      // key don't get in the way, because their generated names aren't reused.
      const second = yield* stack.deploy(keyInRing("RedeployRing", "RedeployKey"));
      expect(second.ring.keyRingId).not.toEqual(first.ring.keyRingId);
      expect(second.ring.displayName).not.toEqual(first.ring.displayName);
      expect(second.key.keyId).not.toEqual(first.key.keyId);
      expect(second.key.state).toEqual("active");

      yield* expectKeyPendingDeletion(scope, first.key.keyRingId, first.key.keyId);

      yield* stack.destroy();
      yield* expectKeyPendingDeletion(scope, second.key.keyRingId, second.key.keyId);
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "a same-named key that isn't ours is refused and left alone",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const ring = yield* stack.deploy(Stackit.KMS.KeyRing("ForeignKeyRing", {}));
      const displayName = "alchemy-test-kms-foreign-key";
      const foreign = yield* kms.createKey({
        ...ringRequest(scope, ring.keyRingId),
        displayName,
        algorithm: "aes_256_gcm",
        purpose: "symmetric_encrypt_decrypt",
        protection: "software",
      });

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const owned = yield* Stackit.KMS.KeyRing("ForeignKeyRing", {});
            return yield* Stackit.KMS.Key("ForeignKey", {
              keyRingId: owned.keyRingId,
              displayName,
              algorithm: "aes_256_gcm",
              purpose: "symmetric_encrypt_decrypt",
            });
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      const untouched = yield* observeKey(scope, ring.keyRingId, foreign.id);
      expect(isPendingDeletion(untouched)).toBe(false);

      // Clean up what the test created itself, then the stack.
      yield* kms.deleteKey({ ...ringRequest(scope, ring.keyRingId), keyId: foreign.id });
      yield* expectKeyPendingDeletion(scope, ring.keyRingId, foreign.id);
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "an empty description counts as none, so a redeploy keeps the key",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const program = keyInRing("EmptyDescriptionRing", "EmptyDescriptionKey", { description: "" });
      const { key } = yield* stack.deploy(program);
      expect(key.description).toBeUndefined();

      const plan = yield* stack.plan(program);
      expect(plan.resources.EmptyDescriptionKey).toMatchObject({ action: "noop" });

      yield* stack.destroy();
      yield* expectKeyPendingDeletion(scope, key.keyRingId, key.keyId);
    }).pipe(logLevel),
  options,
);
