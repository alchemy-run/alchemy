import * as cdn from "@distilled.cloud/azure/cdn";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  orUndefinedIfNotFound,
  stackAndStage,
  waitForProvisioned,
} from "../Arm.ts";

/**
 * Every write on `Microsoft.Cdn` is an ARM async operation even though the
 * SDK models it as synchronous: poll `provisioningState` until `Succeeded`
 * (up to ~10 minutes; Front Door propagation is slow).
 */
export const waitForAfd = <A, E, R>(
  label: string,
  get: Effect.Effect<A | undefined, E, R>,
  stateOf: (value: A) => string | undefined,
) =>
  waitForProvisioned(label, get, stateOf, {
    interval: "5 seconds",
    times: 120,
  });

/** Front Door deletes are long-running (profile deletes take 5-15 minutes). */
export const AFD_DELETE_BUDGET = {
  interval: "10 seconds",
  times: 100,
} as const;

/**
 * Microsoft.Cdn rejects writes on a profile while another write on the same
 * profile is still deploying (`Conflict`); wait it out.
 */
export const whileProfileBusy = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;

/**
 * Deterministic AFD child name: letters, digits, and single hyphens,
 * starting and ending with a letter or digit.
 */
export const createAfdName = Effect.fn(function* (
  id: string,
  maxLength: number,
) {
  const name = yield* createPhysicalName({ id, maxLength, lowercase: true });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

/**
 * Deterministic rule-set / rule name: letters and digits only, starting
 * with a letter (at most 60 characters).
 */
export const createAlphanumericName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 60,
    lowercase: true,
    delimiter: "",
  });
  const clean = name.replace(/[^a-z0-9]/g, "");
  return /^[a-z]/.test(clean) ? clean : `r${clean.slice(0, 59)}`;
});

/**
 * Whether `observed` already satisfies `desired`: every field the user set
 * is present with the same value (Azure fills in defaults for the rest).
 * ARM resource IDs (`id` fields) compare case-insensitively; an empty
 * desired list matches an omitted one.
 */
export const matchesDesired = (
  desired: unknown,
  observed: unknown,
  key?: string,
): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    if (desired.length === 0 && (observed === undefined || observed === null)) {
      return true;
    }
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((item, i) => matchesDesired(item, observed[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(([k, value]) =>
      matchesDesired(value, (observed as Record<string, unknown>)[k], k),
    );
  }
  if (
    key === "id" &&
    typeof desired === "string" &&
    typeof observed === "string"
  ) {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return desired === observed;
};

/** Desired fields whose observed value differs (the PATCH body). */
export const changedFields = <T extends object>(
  desired: T,
  observed: object | undefined,
): Partial<T> => {
  const changed: Partial<T> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (
      value !== undefined &&
      !matchesDesired(
        value,
        (observed as Record<string, unknown> | undefined)?.[key],
      )
    ) {
      Object.assign(changed, { [key]: value });
    }
  }
  return changed;
};

/** `{ id }` reference, or `undefined` when no ID is given. */
export const ref = (id: string | undefined) =>
  id === undefined ? undefined : { id };

/**
 * AFD child resources carry no tags. They are owned when their profile
 * carries this stack's and stage's ownership tags.
 */
export const profileOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  profileName: string,
) {
  const profile = yield* orUndefinedIfNotFound(
    cdn.GetProfile({ subscriptionId, resourceGroupName, profileName }),
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    profile?.tags?.["alchemy::stack"] === stack &&
    profile?.tags?.["alchemy::stage"] === stage
  );
});

/** Case-insensitive equality for ARM names. */
export const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();
