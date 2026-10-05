import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Resource provider namespace of Azure Arc-enabled SCVMM. */
export const SCVMM_NAMESPACE = "Microsoft.ScVmm";

/**
 * Arc custom location that fronts an SCVMM management server through the
 * Arc resource bridge.
 */
export interface ScVmmExtendedLocation {
  /** ARM ID of the `Microsoft.ExtendedLocation/customLocations` resource. */
  name: string;
  /**
   * Extended location type.
   * @default "CustomLocation"
   */
  type?: "CustomLocation";
}

/** The request body form of an extended location. */
export const toExtendedLocation = (location: ScVmmExtendedLocation) => ({
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

/** Reveal a possibly redacted secret. */
export const reveal = (
  value: string | Redacted.Redacted<string> | undefined,
) =>
  value === undefined || typeof value === "string"
    ? value
    : Redacted.value(value);

const segment = (armId: string, pattern: RegExp) => armId.match(pattern)?.[1];

/**
 * Whether the Arc-enabled server (`Microsoft.HybridCompute/machines`) an
 * extension resource hangs off carries the current stack's ownership tags.
 * SCVMM VM instances and guest agents have no tags of their own.
 */
export const isMachineStackOwned = Effect.fn(function* (machineId: string) {
  const subscriptionId = segment(machineId, /\/subscriptions\/([^/]+)/i);
  const resourceGroupName = segment(machineId, /\/resourceGroups\/([^/]+)/i);
  const machineName = segment(machineId, /\/machines\/([^/]+)/i);
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
  const { stack, stage } = yield* stackAndStage;
  const record = tagRecord(machine?.tags);
  return (
    record["alchemy::stack"] === stack && record["alchemy::stage"] === stage
  );
});
