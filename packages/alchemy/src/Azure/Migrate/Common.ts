import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { stackAndStage } from "../Arm.ts";

/** Default physical name for Azure Migrate resources (letters, digits, `-`). */
export const migrateName = (id: string, maxLength = 60) =>
  createPhysicalName({ id, maxLength });

/**
 * Whether a tagged parent (assessment project, migrate project, discovery
 * site) belongs to the current stack and stage. Children cannot be tagged,
 * so they inherit ownership from their parent.
 */
export const ownedByStage = Effect.fn(function* (
  tags: Record<string, string | undefined> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  return (
    tags?.["alchemy::stack"] === stack && tags?.["alchemy::stage"] === stage
  );
});

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase();
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null
  ) {
    return Object.entries(a).every(
      ([k, v]) =>
        v === undefined || deepEqual(v, (b as Record<string, unknown>)[k]),
    );
  }
  return false;
};

/**
 * True when any field the user set differs from the observed value. Fields
 * the user left out are server-defaulted and never cause a write; string
 * comparison is case-insensitive because the service normalizes enum case.
 */
export const settingsDiffer = (desired: object, observed: object | undefined) =>
  !deepEqual(desired, observed ?? {});
