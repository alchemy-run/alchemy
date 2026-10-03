import * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/**
 * Shared scaffolding for Data Factory child entities (pipelines, datasets,
 * linked services, …). Not exported from the service index.
 *
 * Child entities have no tags. Most carry `annotations: string[]`, so
 * Alchemy records ownership as an `alchemy:<stack>/<stage>/<id>` annotation.
 */
const ANNOTATION_PREFIX = "alchemy:";

export const ownershipAnnotation = Effect.fn(function* (id: string) {
  const { stack, stage } = yield* stackAndStage;
  return `${ANNOTATION_PREFIX}${stack}/${stage}/${id}`;
});

/**
 * Whether the parent factory carries this stack/stage's ownership tags.
 * Children with no annotations or description (global parameters, managed
 * virtual networks, managed private endpoints) inherit the factory's
 * ownership.
 */
export const factoryOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  factoryName: string,
) {
  const factory = yield* orUndefinedIfNotFound(
    datafactory.GetFactory({ subscriptionId, resourceGroupName, factoryName }),
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    factory?.tags?.["alchemy::stack"] === stack &&
    factory?.tags?.["alchemy::stage"] === stage
  );
});

/** Description marker for children without annotations. */
export const descriptionMarker = Effect.fn(function* (id: string) {
  const { stack, stage } = yield* stackAndStage;
  return `[alchemy ${stack}/${stage}/${id}]`;
});

const DESCRIPTION_MARKER = /\s*\[alchemy ([^\]]+)\]$/;

/** User description plus the ownership marker. */
export const descriptionWithMarker = (
  description: string | undefined,
  marker: string,
) => (description ? `${description} ${marker}` : marker);

/** Observed description with the ownership marker stripped. */
export const stripDescriptionMarker = (description: string | undefined) => {
  const stripped = description?.replace(DESCRIPTION_MARKER, "");
  return stripped ? stripped : undefined;
};

const isAlchemyAnnotation = (annotation: unknown) =>
  typeof annotation === "string" && annotation.startsWith(ANNOTATION_PREFIX);

/** User annotations plus the ownership annotation. */
export const annotationsWithOwnership = (
  annotations: ReadonlyArray<unknown> | undefined,
  marker: string,
): unknown[] => [
  ...(annotations ?? []).filter((a) => !isAlchemyAnnotation(a)),
  marker,
];

/** Observed annotations with the ownership annotation stripped. */
export const userAnnotations = (
  annotations: ReadonlyArray<unknown> | undefined,
): unknown[] => (annotations ?? []).filter((a) => !isAlchemyAnnotation(a));

/** Whether observed annotations carry this stack/stage/id's marker. */
export const hasOwnershipAnnotation = (
  marker: string,
  annotations: ReadonlyArray<unknown> | undefined,
) => (annotations ?? []).includes(marker);

/**
 * Generated name for a child entity: letters, digits, and `_` (data flow
 * and dataset names may not contain `-`), at most 120 characters.
 */
export const createChildName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 120,
    delimiter: "_",
  });
  return name.replace(/[^A-Za-z0-9_]/g, "_");
});

/**
 * Generated name for entities restricted to letters, digits, and single
 * hyphens (factories, integration runtimes), 3-63 characters.
 */
export const createHyphenName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && Object.keys(value as object).length === 0);

/**
 * Whether `observed` contains everything in `desired`. Data Factory echoes
 * definitions back with server-side defaults added (`dependsOn: []`,
 * `userProperties: []`, …), so extra observed keys are not a difference.
 */
const contains = (observed: unknown, desired: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((value, i) => contains(observed[i], value))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    if (Array.isArray(observed)) return false;
    const record = observed as Record<string, unknown>;
    return Object.entries(desired as Record<string, unknown>).every(
      ([key, value]) => contains(record[key], value),
    );
  }
  return observed === desired;
};

/**
 * True when an observed definition differs from the desired one. Every key
 * of `desired` is a managed field: a desired `undefined` differs from a
 * non-empty observed value (the field was removed).
 */
export const definitionDiffers = (
  desired: Record<string, unknown>,
  observed: object | undefined,
) => {
  if (observed === undefined) return true;
  const record = observed as Record<string, unknown>;
  return Object.keys(desired).some((key) =>
    desired[key] === undefined
      ? !isEmpty(record[key])
      : !contains(record[key], desired[key]),
  );
};
