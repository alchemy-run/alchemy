import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Observe a container registry; `undefined` when it does not exist. */
export const getRegistry = (
  subscriptionId: string,
  resourceGroupName: string,
  registryName: string,
) =>
  orUndefinedIfNotFound(
    containerregistry.GetRegistry({
      subscriptionId,
      resourceGroupName,
      registryName,
    }),
  );

/**
 * Registry children without tags (scope maps, tokens, cache rules,
 * credential sets, connected registries) count as owned when their parent
 * registry carries this stack's and stage's ownership tags.
 */
export const registryOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  registryName: string,
) {
  const observed = yield* getRegistry(
    subscriptionId,
    resourceGroupName,
    registryName,
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    observed?.tags?.["alchemy::stack"] === stack &&
    observed?.tags?.["alchemy::stage"] === stage
  );
});

/**
 * Name for a registry or one of its children: 5-50 letters and digits.
 * Registry names are globally unique (`{name}.azurecr.io`).
 */
export const createRegistryName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 50,
    lowercase: true,
    delimiter: "",
  });
  return name.replace(/[^a-z0-9]/g, "");
});

/** Case-insensitive equality for ARM names, IDs, and locations. */
export const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/** Normalized location (`East US` → `eastus`). */
export const normalizeLocation = (location: string | undefined) =>
  location?.toLowerCase().replace(/\s+/g, "");

/** Lists compared as sets. */
export const sameSet = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
) => {
  const left = [...new Set(a ?? [])].sort();
  const right = [...new Set(b ?? [])].sort();
  return (
    left.length === right.length && left.every((value, i) => value === right[i])
  );
};

/**
 * True when every value set in `desired` equals the observed value
 * (recursively, case-sensitive). Keys left `undefined` in `desired` are not
 * compared.
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
  return desired === observed;
};
