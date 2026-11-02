import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as kms from "@distilled.cloud/stackit/kms";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectKeyRingGone, expectWrappingKeyGone, ringRequest } from "./kms.ts";

const { test } = makeStackitTest();

// Wrapping keys and key rings have no price of their own: ungated. Expiry can't
// be forced, so the renewal path has no live test (see the KMS catalog).
const options = { tags: stackitTags("kms", "wrappingkey"), timeout: 300_000 } as const;

const wrappingKeyInRing = (
  ringId: string,
  wrappingKeyId: string,
  props: Partial<Stackit.KMS.WrappingKeyProps> = {},
) =>
  Effect.gen(function* () {
    const ring = yield* Stackit.KMS.KeyRing(ringId, {});
    const wrappingKey = yield* Stackit.KMS.WrappingKey(wrappingKeyId, {
      keyRingId: ring.keyRingId,
      algorithm: "rsa_2048_oaep_sha256",
      purpose: "wrap_symmetric_key",
      ...props,
    });
    return { ring, wrappingKey };
  });

test.provider(
  "create and delete a wrapping key",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const props = { description: "alchemy test wrapping key" };
      const { ring, wrappingKey } = yield* stack.deploy(
        wrappingKeyInRing("WrapRing", "BasicWrappingKey", props),
      );

      expect(wrappingKey.keyRingId).toEqual(ring.keyRingId);
      expect(wrappingKey.state).toEqual("active");
      expect(wrappingKey.algorithm).toEqual("rsa_2048_oaep_sha256");
      expect(wrappingKey.purpose).toEqual("wrap_symmetric_key");
      expect(wrappingKey.protection).toEqual("software");
      expect(wrappingKey.accessScope).toEqual("PUBLIC");
      expect(wrappingKey.publicKey?.length ?? 0).toBeGreaterThan(0);
      expect(new Date(wrappingKey.expiresAt).getTime()).toBeGreaterThan(Date.now());

      // Out of band: the wrapping key exists with the desired settings.
      const fetched = yield* kms.getWrappingKey({
        ...ringRequest(scope, ring.keyRingId),
        wrappingKeyId: wrappingKey.wrappingKeyId,
      });
      expect(fetched.displayName).toEqual(wrappingKey.displayName);
      expect(fetched.description).toEqual("alchemy test wrapping key");
      expect(fetched.publicKey).toEqual(wrappingKey.publicKey);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(wrappingKeyInRing("WrapRing", "BasicWrappingKey", props));
      expect(plan.resources.BasicWrappingKey).toMatchObject({ action: "noop" });

      yield* stack.destroy();

      // No grace period holds a wrapping key's ring back.
      yield* expectWrappingKeyGone(scope, ring.keyRingId, wrappingKey.wrappingKeyId);
      yield* expectKeyRingGone(scope, ring.keyRingId);
    }).pipe(logLevel),
  options,
);

test.provider(
  "changing the algorithm replaces the wrapping key",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const first = yield* stack.deploy(wrappingKeyInRing("WrapReplaceRing", "ReplaceWrappingKey"));

      const props = { algorithm: "rsa_3072_oaep_sha256" } as const;
      const plan = yield* stack.plan(
        wrappingKeyInRing("WrapReplaceRing", "ReplaceWrappingKey", props),
      );
      expect(plan.resources.ReplaceWrappingKey).toMatchObject({ action: "replace" });

      const second = yield* stack.deploy(
        wrappingKeyInRing("WrapReplaceRing", "ReplaceWrappingKey", props),
      );
      expect(second.ring.keyRingId).toEqual(first.ring.keyRingId);
      expect(second.wrappingKey.wrappingKeyId).not.toEqual(first.wrappingKey.wrappingKeyId);
      expect(second.wrappingKey.algorithm).toEqual("rsa_3072_oaep_sha256");
      expect(second.wrappingKey.publicKey).not.toEqual(first.wrappingKey.publicKey);

      yield* expectWrappingKeyGone(scope, first.ring.keyRingId, first.wrappingKey.wrappingKeyId);

      yield* stack.destroy();
      yield* expectWrappingKeyGone(scope, second.ring.keyRingId, second.wrappingKey.wrappingKeyId);
      yield* expectKeyRingGone(scope, second.ring.keyRingId);
    }).pipe(logLevel),
  options,
);

test.provider(
  "a same-named wrapping key that isn't ours is refused and left alone",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const ring = yield* stack.deploy(Stackit.KMS.KeyRing("WrapForeignRing", {}));
      const displayName = "alchemy-test-kms-foreign-wrapping-key";
      const foreign = yield* kms.createWrappingKey({
        ...ringRequest(scope, ring.keyRingId),
        displayName,
        algorithm: "rsa_2048_oaep_sha256",
        purpose: "wrap_symmetric_key",
        protection: "software",
      });

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const owned = yield* Stackit.KMS.KeyRing("WrapForeignRing", {});
            return yield* Stackit.KMS.WrappingKey("ForeignWrappingKey", {
              keyRingId: owned.keyRingId,
              displayName,
              algorithm: "rsa_2048_oaep_sha256",
              purpose: "wrap_symmetric_key",
            });
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      const fetched = yield* kms.getWrappingKey({
        ...ringRequest(scope, ring.keyRingId),
        wrappingKeyId: foreign.id,
      });
      expect(fetched.state).not.toEqual("deleted");

      yield* kms.deleteWrappingKey({
        ...ringRequest(scope, ring.keyRingId),
        wrappingKeyId: foreign.id,
      });
      yield* expectWrappingKeyGone(scope, ring.keyRingId, foreign.id);
      yield* stack.destroy();
      yield* expectKeyRingGone(scope, ring.keyRingId);
    }).pipe(logLevel),
  options,
);

test.provider(
  "an empty description counts as none, so a redeploy changes nothing",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const program = wrappingKeyInRing("EmptyDescriptionRing", "EmptyDescriptionKey", {
        description: "",
      });
      const { ring, wrappingKey } = yield* stack.deploy(program);
      expect(wrappingKey.description).toBeUndefined();

      const plan = yield* stack.plan(program);
      expect(plan.resources.EmptyDescriptionKey).toMatchObject({ action: "noop" });

      yield* stack.destroy();
      yield* expectWrappingKeyGone(scope, ring.keyRingId, wrappingKey.wrappingKeyId);
      yield* expectKeyRingGone(scope, ring.keyRingId);
    }).pipe(logLevel),
  options,
);
