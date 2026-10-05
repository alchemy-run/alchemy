import * as digitaltwins from "@distilled.cloud/azure/digitaltwins";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Observe a Digital Twins instance; `undefined` when it does not exist. */
export const getInstance = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) =>
  orUndefinedIfNotFound(
    digitaltwins.GetDigitalTwin({
      subscriptionId,
      resourceGroupName,
      resourceName,
    }),
  );

/**
 * Children of an instance (endpoints, time series database connections)
 * carry no tags or metadata. They count as owned when their parent
 * instance carries this stack's and stage's ownership tags.
 */
export const instanceOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  instanceName: string,
) {
  const observed = yield* getInstance(
    subscriptionId,
    resourceGroupName,
    instanceName,
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    observed?.tags?.["alchemy::stack"] === stack &&
    observed?.tags?.["alchemy::stage"] === stage
  );
});

/**
 * Globally unique instance name (it becomes the data-plane hostname):
 * 3-63 letters, digits, and hyphens, starting and ending with a letter or
 * digit.
 */
export const createInstanceName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
  });
  return name.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
});

/**
 * Name for an endpoint or time series database connection: 2-49 letters,
 * digits, and hyphens, starting and ending with a letter or digit.
 */
export const createChildName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 49 });
  return name.replace(/[^a-zA-Z0-9-]/g, "-").replace(/^-+|-+$/g, "");
});

/** Unwrap a secret prop that may be given as plain text or `Redacted`. */
export const secretValue = (
  value: string | Redacted.Redacted<string> | undefined,
) =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

/** Managed identity a child resource uses to reach its target. */
export interface ManagedIdentityReference {
  /** `SystemAssigned` uses the instance's system identity; `UserAssigned` needs `userAssignedIdentity`. */
  type: "SystemAssigned" | "UserAssigned";
  /** ARM resource ID of the user-assigned identity when `type` is `UserAssigned`. */
  userAssignedIdentity?: string;
}

export const sameIdentityReference = (
  observed: digitaltwins.ManagedIdentityReference | null | undefined,
  desired: ManagedIdentityReference | undefined,
) =>
  (observed?.type ?? undefined) === desired?.type &&
  (observed?.userAssignedIdentity ?? "").toLowerCase() ===
    (desired?.userAssignedIdentity ?? "").toLowerCase();
