import * as cloudhealth from "@distilled.cloud/azure/cloudhealth";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/**
 * Shared scaffolding for Azure Monitor health models and their children.
 * Not exported from the service index.
 */

/** ARM resource provider namespace of health models. */
export const NAMESPACE = "Microsoft.CloudHealth";

/** ARM names compare case-insensitively. */
export const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/** Where a health model child lives. */
export interface ModelWhere {
  subscriptionId: string;
  resourceGroupName: string;
  healthModelName: string;
}

const toName = (raw: string, maxLength: number, prefix: string) => {
  const name = raw
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/, "");
  return /^[a-zA-Z]/.test(name) ? name : `${prefix}-${name}`.slice(0, maxLength);
};

/** Health model name: 3-44 letters, digits, and hyphens, starting with a letter. */
export const createHealthModelName = Effect.fn(function* (id: string) {
  const raw = yield* createPhysicalName({ id, maxLength: 44, lowercase: true });
  return toName(raw, 44, "hm");
});

/** Child name: 3-260 letters, digits, and hyphens, starting and ending with a letter or digit. */
export const createChildName = Effect.fn(function* (id: string) {
  const raw = yield* createPhysicalName({ id, maxLength: 260, lowercase: true });
  return toName(raw, 260, "hm");
});

export const getHealthModel = (where: ModelWhere) =>
  orUndefinedIfNotFound(cloudhealth.GetHealthModel(where));

/**
 * Authentication settings and discovery rules carry no tags, so a child is
 * owned by whoever owns its health model: the model must carry this
 * stack/stage's ownership tags.
 */
export const healthModelOwnedByStack = Effect.fn(function* (where: ModelWhere) {
  const model = yield* getHealthModel(where);
  const { stack, stage } = yield* stackAndStage;
  return model?.tags?.["alchemy::stack"] === stack && model?.tags?.["alchemy::stage"] === stage;
});

/**
 * Whether every field set in `desired` has the same value in `observed`.
 * Objects compare recursively, arrays element by element (same length),
 * so server-populated fields the user did not set are ignored.
 */
export const isSubset = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((item, i) => isSubset(item, observed[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired as Record<string, unknown>).every(([key, value]) =>
      isSubset(value, (observed as Record<string, unknown>)[key]),
    );
  }
  return desired === observed;
};

/**
 * A health model rejects child writes while a previous operation on the
 * model is still running (`Conflict`); short waits converge.
 */
export const whileBusy = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("5 seconds"),
  times: 12,
} as const;
