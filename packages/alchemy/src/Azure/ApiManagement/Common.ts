import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/**
 * Deterministic entity id for a child entity (APIs, products, backends, ...):
 * lowercase letters, digits, and hyphens, at most 80 characters.
 */
export const createEntityName = (id: string) =>
  createPhysicalName({ id, maxLength: 80, lowercase: true });

/** Read the parent API Management service, or `undefined` when missing. */
export const getService = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
) =>
  orUndefinedIfNotFound(
    apim.GetApiManagementService({
      subscriptionId,
      resourceGroupName,
      serviceName,
    }),
  );

/**
 * Whether the parent service belongs to the current stack and stage. Child
 * entities cannot carry ARM tags, so ownership follows the parent service's
 * `alchemy::stack` / `alchemy::stage` tags.
 */
export const isParentOwned = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
) {
  const service = yield* getService(
    subscriptionId,
    resourceGroupName,
    serviceName,
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    service?.tags?.["alchemy::stack"] === stack &&
    service?.tags?.["alchemy::stage"] === stage
  );
});

/** Case-insensitive comparison for Azure names and locations. */
export const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/**
 * Whether every value set in `desired` is present in `observed`. APIM fills
 * in defaults (`required: false`, `values: []`, ...) on GET, so desired
 * state is compared as a subset; arrays must match element by element.
 */
export const subsetMatches = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((item, index) => subsetMatches(item, observed[index]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(([key, value]) =>
      subsetMatches(value, (observed as Record<string, unknown>)[key]),
    );
  }
  return desired === observed;
};

/** Logger name of a logger ARM id (GET may return a service-relative id). */
export const loggerNameOf = (loggerId: string | undefined) =>
  loggerId?.split("/loggers/")[1];
