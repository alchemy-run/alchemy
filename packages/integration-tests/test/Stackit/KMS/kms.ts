import { expect } from "@alchemy.run/test";
import * as kms from "@distilled.cloud/stackit/kms";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared helpers of the STACKIT KMS suites.
 *
 * A key version is billed per hour or part thereof (EUR 0.0021, price list
 * v1.0.44), so every suite that creates keys is gated behind the provider-wide
 * slow flag `STACKIT_TEST_SLOW`. Whether a key pending deletion keeps billing is
 * unknown (see `processes/Stackit/catalog/kms.md`). Key rings and wrapping keys
 * have no price of their own, so their lifecycles run ungated.
 */
export const slow = !process.env.STACKIT_TEST_SLOW;

export interface Scope {
  readonly projectId: string;
  readonly region: string;
}

export const ringRequest = (scope: Scope, keyRingId: string) => ({
  projectId: scope.projectId,
  regionId: scope.region,
  keyRingId,
});

/** Out-of-band key state: the key, or "gone" (typed `NotFound`). */
export const observeKey = (scope: Scope, keyRingId: string, keyId: string) =>
  kms
    .getKey({ ...ringRequest(scope, keyRingId), keyId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** Out-of-band ring state: the ring, or "gone" (typed `NotFound` or `deleted`). */
export const observeKeyRing = (scope: Scope, keyRingId: string) =>
  kms.getKeyRing(ringRequest(scope, keyRingId)).pipe(
    Effect.map((ring) => (ring.state === "deleted" ? ("gone" as const) : ring)),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

/** Out-of-band wrapping key state: the wrapping key, or "gone" (`NotFound` or `deleted`). */
export const observeWrappingKey = (scope: Scope, keyRingId: string, wrappingKeyId: string) =>
  kms.getWrappingKey({ ...ringRequest(scope, keyRingId), wrappingKeyId }).pipe(
    Effect.map((wrappingKey) =>
      wrappingKey.state === "deleted" ? ("gone" as const) : wrappingKey,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

/** Whether an observed key has had its deletion scheduled, or finished. */
export const isPendingDeletion = (key: kms.Key | "gone") =>
  key === "gone" || key.state === "deleted" || key.deletionDate !== undefined;

/**
 * Bounded check that a key's deletion is scheduled, not that it is restored or
 * still usable. A pending key must not be scheduled in the past.
 */
export const expectKeyPendingDeletion = (scope: Scope, keyRingId: string, keyId: string) =>
  observeKey(scope, keyRingId, keyId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: isPendingDeletion,
      times: 20,
    }),
    Effect.map((key) => {
      expect(isPendingDeletion(key)).toBe(true);
      if (key !== "gone" && key.deletionDate !== undefined) {
        expect(new Date(key.deletionDate).getTime()).toBeGreaterThan(Date.now());
      }
      return key;
    }),
  );

/** Bounded check that a key ring is gone. */
export const expectKeyRingGone = (scope: Scope, keyRingId: string) =>
  observeKeyRing(scope, keyRingId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (ring) => ring === "gone",
      times: 20,
    }),
    Effect.map((ring) => expect(ring).toEqual("gone")),
  );

/** Bounded check that a wrapping key is gone. */
export const expectWrappingKeyGone = (scope: Scope, keyRingId: string, wrappingKeyId: string) =>
  observeWrappingKey(scope, keyRingId, wrappingKeyId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (wrappingKey) => wrappingKey === "gone",
      times: 20,
    }),
    Effect.map((wrappingKey) => expect(wrappingKey).toEqual("gone")),
  );
