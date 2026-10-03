import * as ml from "@distilled.cloud/azure/machinelearningservices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";

/**
 * The field-wise view of a plan-time `news` input, or `undefined` when the
 * whole props object is a single unresolved expression.
 */
export function inputFields<P extends object>(
  news: Input<P>,
):
  | Exclude<
      Input<P>,
      Output.Output<any> | Effect.Effect<any, any, any> | Config.Config<any>
    >
  | undefined;
export function inputFields(news: unknown): unknown {
  return Output.isOutput(news) || Effect.isEffect(news) || Config.isConfig(news)
    ? undefined
    : news;
}

/** An ARM tag map with `null` values (as some SDK shapes declare) dropped. */
export const armTags = (
  tags: { [key: string]: string | null | undefined } | null | undefined,
): Record<string, string> | undefined =>
  tags == null
    ? undefined
    : Object.fromEntries(
        Object.entries(tags).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );

/**
 * Generate a workspace or registry name: 3-33 letters, digits, `-`, and
 * `_`, starting with a letter or digit.
 */
export const createWorkspaceName = Effect.fn(function* (
  id: string,
  maxLength = 33,
) {
  const name = yield* createPhysicalName({ id, maxLength, lowercase: true });
  return name.replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z0-9]+|-+$/g, "");
});

/**
 * Generate a workspace child name (connection, schedule, endpoint, ...):
 * lowercase letters, digits, and `-`, starting with a letter. With
 * `underscores`, only letters, digits, and `_` (datastores).
 */
export const createChildName = Effect.fn(function* (
  id: string,
  maxLength: number,
  options: { underscores?: boolean } = {},
) {
  const name = yield* createPhysicalName({
    id,
    maxLength,
    lowercase: true,
    delimiter: options.underscores ? "_" : "-",
  });
  const cleaned = name
    .replace(
      options.underscores ? /[^a-z0-9_]/g : /[^a-z0-9-]/g,
      options.underscores ? "_" : "-",
    )
    .replace(/[^a-z0-9]+$/g, "");
  return /^[a-z]/.test(cleaned) ? cleaned : `a${cleaned.slice(1)}`;
});

/** ARM names, IDs, and locations compare case-insensitively. */
export const sameArm = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && v !== null)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
};

/**
 * Structural equality ignoring key order and `undefined`/`null` members,
 * for comparing desired nested settings against what ARM returns.
 */
export const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * Whether every key of `desired` matches `observed` (extra observed keys
 * ignored), recursing into nested objects.
 */
export const containsValue = (observed: unknown, desired: unknown): boolean => {
  if (desired === undefined || desired === null) return true;
  if (
    typeof desired === "object" &&
    !Array.isArray(desired) &&
    observed !== null &&
    typeof observed === "object" &&
    !Array.isArray(observed)
  ) {
    return Object.entries(desired as Record<string, unknown>).every(
      ([key, value]) =>
        containsValue((observed as Record<string, unknown>)[key], value),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return sameValue(observed, desired);
};

export type MachineLearningIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned,UserAssigned";

export interface MachineLearningIdentity {
  /** Managed identity type. */
  type: MachineLearningIdentityType;
  /**
   * ARM resource IDs of user-assigned identities. Required when `type`
   * includes `UserAssigned`.
   */
  userAssignedIdentities?: string[];
}

/** The ARM request shape for a managed identity. */
export const toArmIdentity = (identity: MachineLearningIdentity | undefined) =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities: identity.userAssignedIdentities
          ? Object.fromEntries(
              identity.userAssignedIdentities.map((id) => [id, {}]),
            )
          : undefined,
      };

const normalizeIdentityType = (type: string | undefined) =>
  (type ?? "None").replace(/\s/g, "").toLowerCase();

/** Whether the observed identity differs from the desired one. */
export const identityDiffers = (
  observed:
    | {
        type?: string;
        userAssignedIdentities?: Record<string, unknown> | null;
      }
    | undefined,
  desired: MachineLearningIdentity | undefined,
) => {
  if (desired === undefined) return false;
  if (
    normalizeIdentityType(observed?.type) !==
    normalizeIdentityType(desired.type)
  ) {
    return true;
  }
  const observedIds = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const desiredIds = (desired.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  return observedIds.join("|") !== desiredIds.join("|");
};

/** Location of a workspace (the default location of its children). */
export const workspaceLocation = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
) =>
  ml
    .GetWorkspace({ subscriptionId, resourceGroupName, workspaceName })
    .pipe(Effect.map((workspace) => workspace.location ?? ""));
