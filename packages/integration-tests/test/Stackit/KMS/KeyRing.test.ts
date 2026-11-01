import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as kms from "@distilled.cloud/stackit/kms";
import { adopt } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  expectKeyPendingDeletion,
  expectKeyRingGone,
  isPendingDeletion,
  observeKey,
  observeKeyRing,
  ringRequest,
  slow,
} from "./kms.ts";

const { test } = makeStackitTest();

// A key ring has no price of its own, so its lifecycle runs ungated. Cases that
// need a key in the ring are gated: see `kms.ts`.
const options = { tags: stackitTags("kms", "keyring"), timeout: 300_000 } as const;

test.provider(
  "create and delete an empty key ring",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const props = { description: "alchemy test key ring" };
      const ring = yield* stack.deploy(Stackit.KMS.KeyRing("BasicRing", props));

      expect(ring.projectId).toEqual(projectId);
      expect(ring.region).toEqual(region);
      expect(ring.state).toEqual("active");
      expect(ring.description).toEqual("alchemy test key ring");
      expect(ring.displayName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);

      // Out of band: the ring exists with the desired settings.
      const fetched = yield* kms.getKeyRing(ringRequest(scope, ring.keyRingId));
      expect(fetched.state).toEqual("active");
      expect(fetched.displayName).toEqual(ring.displayName);
      expect(fetched.description).toEqual("alchemy test key ring");

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.KMS.KeyRing("BasicRing", props));
      expect(plan.resources.BasicRing).toMatchObject({ action: "noop" });

      yield* stack.destroy();

      // An empty ring is really deleted, not left behind.
      yield* expectKeyRingGone(scope, ring.keyRingId);
    }).pipe(logLevel),
  options,
);

test.provider(
  "changing a generated-name ring's description creates the new ring first",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const created = yield* stack.deploy(Stackit.KMS.KeyRing("ReplaceRing", {}));

      const props = { description: "replaced" };
      const plan = yield* stack.plan(Stackit.KMS.KeyRing("ReplaceRing", props));
      expect(plan.resources.ReplaceRing).toMatchObject({ action: "replace" });

      const replaced = yield* stack.deploy(Stackit.KMS.KeyRing("ReplaceRing", props));
      expect(replaced.keyRingId).not.toEqual(created.keyRingId);
      expect(replaced.displayName).not.toEqual(created.displayName);
      expect(replaced.description).toEqual("replaced");

      yield* expectKeyRingGone(scope, created.keyRingId);
      const fetched = yield* kms.getKeyRing(ringRequest(scope, replaced.keyRingId));
      expect(fetched.state).toEqual("active");

      yield* stack.destroy();
      yield* expectKeyRingGone(scope, replaced.keyRingId);
    }).pipe(logLevel),
  options,
);

test.provider(
  "an explicit name is kept across a replacement, and the old ring is not reclaimed",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const displayName = "alchemy-test-kms-replace-ring";
      const created = yield* stack.deploy(
        Stackit.KMS.KeyRing("NamedRing", { displayName, description: "first" }),
      );
      expect(created.displayName).toEqual(displayName);

      const replaced = yield* stack.deploy(
        Stackit.KMS.KeyRing("NamedRing", { displayName, description: "second" }),
      );
      expect(replaced.displayName).toEqual(displayName);
      expect(replaced.description).toEqual("second");
      expect(replaced.keyRingId).not.toEqual(created.keyRingId);

      yield* expectKeyRingGone(scope, created.keyRingId);
      const fetched = yield* kms.getKeyRing(ringRequest(scope, replaced.keyRingId));
      expect(fetched.description).toEqual("second");

      yield* stack.destroy();
      yield* expectKeyRingGone(scope, replaced.keyRingId);
    }).pipe(logLevel),
  options,
);

test.provider(
  "a same-named ring is unowned until adopted",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      // Out of band, under a constant name. A run interrupted before the adopted
      // destroy leaves it there, and the next run reuses it.
      const displayName = "alchemy-test-kms-foreign-ring";
      const { keyRings } = yield* kms.listKeyRings({ projectId, regionId: region });
      const foreign =
        keyRings.find((ring) => ring.displayName === displayName && ring.state !== "deleted") ??
        (yield* kms.createKeyRing({ projectId, regionId: region, displayName }));

      const ring = Stackit.KMS.KeyRing("ForeignRing", { displayName });
      const error = yield* stack.plan(ring).pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      const adopted = yield* stack.deploy(ring.pipe(adopt(true)));
      expect(adopted.keyRingId).toEqual(foreign.id);

      // Once adopted, destroy deletes it.
      yield* stack.destroy();
      yield* expectKeyRingGone(scope, foreign.id);
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "a live key that isn't ours fails the delete and survives it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const ring = yield* stack.deploy(Stackit.KMS.KeyRing("BlockedRing", {}));

      // Created out of band: the stack knows nothing about this key.
      const foreign = yield* kms.createKey({
        ...ringRequest(scope, ring.keyRingId),
        displayName: "alchemy-test-kms-foreign-key",
        algorithm: "aes_256_gcm",
        purpose: "symmetric_encrypt_decrypt",
        protection: "software",
      });

      const error = yield* stack.destroy().pipe(Effect.flip);
      expect(error._tag).toEqual("Stackit.KMS.KeyRingNotEmpty");

      const untouched = yield* observeKey(scope, ring.keyRingId, foreign.id);
      expect(isPendingDeletion(untouched)).toBe(false);

      // With only a pending key left, the ring leaves state with a warning. The
      // ring itself stays in the project until the key is gone.
      yield* kms.deleteKey({ ...ringRequest(scope, ring.keyRingId), keyId: foreign.id });
      yield* expectKeyPendingDeletion(scope, ring.keyRingId, foreign.id);
      yield* stack.destroy();

      const left = yield* observeKeyRing(scope, ring.keyRingId);
      expect(left).toMatchObject({ id: ring.keyRingId, state: "active" });

      // State is empty: a new deploy gets a new ring, under a new generated name.
      const next = yield* stack.deploy(Stackit.KMS.KeyRing("BlockedRing", {}));
      expect(next.keyRingId).not.toEqual(ring.keyRingId);
      expect(next.displayName).not.toEqual(ring.displayName);

      yield* stack.destroy();
      yield* expectKeyRingGone(scope, next.keyRingId);
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "an explicit name left behind by a destroy is refused until adopted",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      // A previous run leaves this ring behind, because its key is pending
      // deletion for longer than the gap between runs: take it over, always.
      const displayName = "alchemy-test-kms-residual-ring";
      const ring = () => Stackit.KMS.KeyRing("ResidualRing", { displayName });
      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const adopted = yield* ring().pipe(adopt(true));
          const key = yield* Stackit.KMS.Key("ResidualKey", {
            keyRingId: adopted.keyRingId,
            algorithm: "aes_256_gcm",
            purpose: "symmetric_encrypt_decrypt",
          });
          return { ring: adopted, key };
        }),
      );

      yield* stack.destroy();
      yield* expectKeyPendingDeletion(scope, first.ring.keyRingId, first.key.keyId);
      expect(yield* observeKeyRing(scope, first.ring.keyRingId)).toMatchObject({
        id: first.ring.keyRingId,
      });

      // Indistinguishable from a foreign ring: nothing proves it was ours.
      const error = yield* stack.plan(ring()).pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      const adopted = yield* stack.deploy(ring().pipe(adopt(true)));
      expect(adopted.keyRingId).toEqual(first.ring.keyRingId);
      // The pending key is not restored by taking its ring over.
      yield* expectKeyPendingDeletion(scope, first.ring.keyRingId, first.key.keyId);

      yield* stack.destroy();
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

      const ring = Stackit.KMS.KeyRing("EmptyDescriptionRing", { description: "" });
      const created = yield* stack.deploy(ring);
      expect(created.description).toBeUndefined();

      const plan = yield* stack.plan(ring);
      expect(plan.resources.EmptyDescriptionRing).toMatchObject({ action: "noop" });

      yield* stack.destroy();
      yield* expectKeyRingGone(scope, created.keyRingId);
    }).pipe(logLevel),
  options,
);
