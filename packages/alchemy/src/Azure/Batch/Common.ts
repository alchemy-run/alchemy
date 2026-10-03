import * as batch from "@distilled.cloud/azure/batch";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";

/** Observe a Batch account; `undefined` when it does not exist. */
export const getBatchAccount = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    batch.GetBatchAccount({ subscriptionId, resourceGroupName, accountName }),
  );

/**
 * Name for a Batch child (pool, application): 1-64 letters, digits,
 * hyphens, and underscores.
 */
export const createBatchChildName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 64 });
  return name.replace(/[^A-Za-z0-9_-]/g, "-");
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether every field set in `desired` equals the observed value. Fields
 * Azure fills with defaults (and `desired` omits) are ignored, so a
 * server-normalized object does not cause a perpetual update. Strings
 * compare case-insensitively (ARM echoes enums and IDs in other casings).
 */
export const matches = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((item, i) => matches(item, observed[i]))
    );
  }
  if (isRecord(desired)) {
    return (
      isRecord(observed) &&
      Object.entries(desired).every(([key, value]) =>
        matches(value, observed[key]),
      )
    );
  }
  return desired === observed;
};

/** Structural equality of two prop values (for replacement checks in diff). */
export const sameValue = (a: unknown, b: unknown) =>
  matches(a, b) && matches(b, a);
