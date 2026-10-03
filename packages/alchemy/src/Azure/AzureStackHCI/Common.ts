import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Resource provider namespace of Azure Local (formerly Azure Stack HCI). */
export const HCI_NAMESPACE = "Microsoft.AzureStackHCI";

/**
 * Arc custom location that hosts an Arc VM management resource. Backed by
 * the Arc Resource Bridge running on an Azure Local cluster.
 */
export interface HciExtendedLocation {
  /** ARM ID of the `Microsoft.ExtendedLocation/customLocations` resource. */
  name: string;
  /**
   * Extended location type.
   * @default "CustomLocation"
   */
  type?: "CustomLocation";
}

/** The request body form of an extended location. */
export const toExtendedLocation = (location: HciExtendedLocation) => ({
  name: location.name,
  type: location.type ?? "CustomLocation",
});

const canonical = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return canonical(Redacted.value(value));
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
};

/**
 * Structural equality of plain prop values (key order and `undefined`
 * ignored; redacted secrets compared by value).
 */
export const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Case-insensitive equality of ARM names and IDs. */
export const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/**
 * Whether a parent resource's tags carry the current stack and stage.
 * Child and extension resources of this RP have no tags of their own, so
 * their ownership follows the parent's.
 */
export const isStackOwnedTags = Effect.fn(function* (
  tags: Record<string, string | undefined> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  const record = tagRecord(tags);
  return (
    record["alchemy::stack"] === stack && record["alchemy::stage"] === stage
  );
});

/** Resource group name segment of an ARM ID. */
export const resourceGroupFromId = (armId: string) =>
  armId.match(/\/resourceGroups\/([^/]+)/i)?.[1];

/** Subscription segment of an ARM ID. */
export const subscriptionFromId = (armId: string) =>
  armId.match(/\/subscriptions\/([^/]+)/i)?.[1];

/** Last path segment (resource name) of an ARM ID. */
export const nameFromId = (armId: string) =>
  armId
    .split("/")
    .filter((part) => part.length > 0)
    .pop();

/**
 * Whether the Arc-enabled server (`Microsoft.HybridCompute/machines`) an
 * extension resource hangs off carries the current stack's ownership tags.
 */
export const isMachineStackOwned = Effect.fn(function* (machineId: string) {
  const subscriptionId = subscriptionFromId(machineId);
  const resourceGroupName = resourceGroupFromId(machineId);
  const machineName = nameFromId(machineId);
  if (
    subscriptionId === undefined ||
    resourceGroupName === undefined ||
    machineName === undefined
  ) {
    return false;
  }
  const machine = yield* orUndefinedIfNotFound(
    hybridcompute.GetMachine({
      subscriptionId,
      resourceGroupName,
      machineName,
    }),
  );
  return yield* isStackOwnedTags(machine?.tags);
});
