import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { stackAndStage, type WaitBudget } from "../Arm.ts";

/**
 * Generate a Health Data Services name (workspace, FHIR or DICOM service):
 * 3-24 lowercase letters and digits, starting with a letter.
 */
export const createHealthcareName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 24,
    lowercase: true,
    delimiter: "",
  });
  const cleaned = name.replace(/[^a-z0-9]/g, "");
  return /^[a-z]/.test(cleaned) ? cleaned : `h${cleaned}`.slice(0, 24);
});

/** ARM names, IDs, and locations compare case-insensitively. */
export const sameArm = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/** Workspaces converge in about a minute. */
export const WORKSPACE_BUDGET: WaitBudget = {
  interval: "5 seconds",
  times: 72,
};

/**
 * FHIR and DICOM services take several minutes to provision and delete;
 * first-time provisioning in a region was observed to take over 25 minutes.
 */
export const SERVICE_BUDGET: WaitBudget = {
  interval: "15 seconds",
  times: 160,
};

/**
 * A workspace cannot be deleted while ARM still lists its FHIR/DICOM
 * services, which lingers briefly after their delete completes.
 */
export const whileChildrenExist = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "CannotDeleteResource" || e._tag === "ResourceConflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 18,
} as const;

/**
 * Structural equality where `undefined` members and missing members are
 * the same, so a desired object without optional fields matches the
 * observed one.
 */
export const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((value, i) => sameValue(value, b[i]));
  }
  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null
  ) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (!sameValue(left[key], right[key])) return false;
    }
    return true;
  }
  return false;
};

/**
 * Whether every member set in `desired` matches `observed` (members left
 * `undefined` are Azure-defaulted and not compared).
 */
export const covers = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) return sameValue(desired, observed);
  if (typeof desired === "object" && desired !== null) {
    if (typeof observed !== "object" || observed === null) return false;
    const want = desired as Record<string, unknown>;
    const have = observed as Record<string, unknown>;
    return Object.keys(want).every((key) => covers(want[key], have[key]));
  }
  return desired === observed;
};

export type HealthcareIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned,UserAssigned";

export interface HealthcareIdentity {
  /** Managed identity type. */
  type: HealthcareIdentityType;
  /** ARM IDs of user-assigned managed identities to attach. */
  userAssignedIdentities?: string[];
}

/** Request body for a managed identity. */
export const identityBody = (identity: HealthcareIdentity | undefined) =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities:
          identity.userAssignedIdentities === undefined
            ? undefined
            : Object.fromEntries(
                identity.userAssignedIdentities.map((id) => [id, {}]),
              ),
      };

/** Whether the observed identity matches the desired one. */
export const sameIdentity = (
  desired: HealthcareIdentity | undefined,
  observed:
    | { type: string; userAssignedIdentities?: Record<string, unknown> }
    | undefined,
) => {
  if (desired === undefined) return true;
  const type = observed?.type ?? "None";
  if (type.replace(/\s/g, "").toLowerCase() !== desired.type.toLowerCase()) {
    return false;
  }
  const want = (desired.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  return want.join("\n") === have.join("\n");
};

/**
 * Microsoft.HealthcareApis rejects tag names containing `:` (`BadRequest:
 * The tag name cannot include ... ':'`), so Alchemy ownership markers use
 * `alchemy_*` keys instead of the `alchemy::*` tags.
 */
const MARKER_PREFIX = "alchemy_";

/** Desired tags: the user's tags plus `alchemy_*` ownership markers. */
export const desiredMarkerTags = Effect.fn(function* (
  id: string,
  tags: Record<string, string> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  return {
    ...tags,
    alchemy_stack: stack,
    alchemy_stage: stage,
    alchemy_id: id,
  } as Record<string, string>;
});

/** Whether observed tags carry this stack/stage/id's markers. */
export const ownsMarkerTags = Effect.fn(function* (
  id: string,
  tags: Record<string, string | undefined> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  return (
    tags?.alchemy_stack === stack &&
    tags?.alchemy_stage === stage &&
    tags?.alchemy_id === id
  );
});

/** Whether tags carry any Alchemy ownership marker (used by `list`). */
export const hasAnyMarker = (
  tags: Record<string, string | undefined> | undefined,
) => tags !== undefined && "alchemy_stack" in tags;

/** User-facing tags (ownership markers stripped). */
export const userMarkerTags = (
  tags: Record<string, string | undefined> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith(MARKER_PREFIX),
    ),
  );

/** True when observed tags differ from the desired tags (key-order-insensitive). */
export const markerTagsDiffer = (
  observed: Record<string, string | undefined> | undefined,
  desired: Record<string, string>,
) => {
  const norm = (m: Record<string, string | undefined> | undefined) =>
    JSON.stringify(
      Object.entries(m ?? {})
        .filter(([, v]) => v !== undefined)
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
    );
  return norm(observed) !== norm(desired);
};

/**
 * FHIR/DICOM services reject writes and deletes with ARM `RequestConflict`
 * (mapped client-wide to `CognitiveServicesRequestConflict`) while their
 * provisioning state is not terminal, e.g. during a slow create.
 */
export const whileNotTerminal = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "CognitiveServicesRequestConflict",
  schedule: Schedule.spaced("20 seconds"),
  times: 45,
} as const;
