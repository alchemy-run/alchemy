import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { stackAndStage } from "../Arm.ts";

/**
 * Name for an Azure Virtual Desktop object (host pool, application group,
 * workspace, scaling plan, application, schedule): letters, digits, `@`,
 * `.`, `-`, `_`, and spaces.
 */
export const createAvdName = (id: string, maxLength: number) =>
  createPhysicalName({ id, maxLength });

/**
 * True when every value set in `desired` equals the observed value
 * (recursively). Keys left `undefined` in `desired` are not compared, and
 * strings compare case-insensitively (ARM echoes IDs and enums with
 * different casing).
 */
export const matchesObserved = (
  desired: unknown,
  observed: unknown,
): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((value, i) => matchesObserved(value, observed[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(([key, value]) =>
      matchesObserved(value, (observed as Record<string, unknown>)[key]),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return desired === observed;
};

/**
 * The subset of `desired` whose values differ from `observed` — the body
 * of a PATCH. `undefined` when nothing differs.
 */
export const deltaOf = <T extends object>(
  desired: T,
  observed: object | undefined,
): Partial<T> | undefined => {
  const delta: Partial<T> = {};
  let changed = false;
  for (const [key, value] of Object.entries(desired) as [keyof T, unknown][]) {
    if (value === undefined) continue;
    const current = (observed as Record<keyof T, unknown> | undefined)?.[key];
    if (!matchesObserved(value, current)) {
      delta[key] = value as T[keyof T];
      changed = true;
    }
  }
  return changed ? delta : undefined;
};

/** ARM resource IDs compared as a case-insensitive set. */
export const sameIdSet = (
  a: ReadonlyArray<string> | null | undefined,
  b: ReadonlyArray<string> | null | undefined,
) => {
  const left = [...new Set((a ?? []).map((id) => id.toLowerCase()))].sort();
  const right = [...new Set((b ?? []).map((id) => id.toLowerCase()))].sort();
  return left.length === right.length && left.every((id, i) => id === right[i]);
};

/**
 * Children without tags (applications, scaling plan schedules) count as
 * owned when their parent carries this stack's and stage's ownership tags.
 */
export const ownedByStage = Effect.fn(function* (
  tags: Record<string, string | undefined> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  return (
    tags?.["alchemy::stack"] === stack && tags?.["alchemy::stage"] === stage
  );
});

/** Last segment of an ARM ID, e.g. the application name in `ag/app`. */
export const leafName = (name: string | undefined) =>
  name?.split("/").pop() ?? "";
