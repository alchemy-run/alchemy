import * as iothub from "@distilled.cloud/azure/iothub";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Observe an IoT hub; `undefined` when it does not exist. */
export const getIotHub = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) =>
  orUndefinedIfNotFound(
    iothub.GetIotHubResource({
      subscriptionId,
      resourceGroupName,
      resourceName,
    }),
  );

/**
 * Children of a hub (consumer groups, certificates) carry no tags or
 * metadata. They count as owned when their parent hub carries this stack's
 * and stage's ownership tags.
 */
export const iotHubOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) {
  const observed = yield* getIotHub(
    subscriptionId,
    resourceGroupName,
    resourceName,
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    observed?.tags?.["alchemy::stack"] === stack &&
    observed?.tags?.["alchemy::stage"] === stage
  );
});

/**
 * Globally unique IoT hub name (`{name}.azure-devices.net`): 3-50 letters,
 * digits, and hyphens, not ending with a hyphen.
 */
export const createIotHubName = Effect.fn(function* (id: string) {
  return (yield* createPhysicalName({ id, maxLength: 50, lowercase: true }))
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

/**
 * Name of a hub child (consumer group, certificate): letters, digits,
 * periods, hyphens, and underscores, starting and ending with a letter or
 * digit.
 */
export const createChildName = Effect.fn(function* (
  id: string,
  maxLength: number,
) {
  const name = yield* createPhysicalName({ id, maxLength });
  return name.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
});

/**
 * True when every value set in `desired` equals the observed value
 * (recursively). Keys left `undefined` in `desired` are not compared.
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
