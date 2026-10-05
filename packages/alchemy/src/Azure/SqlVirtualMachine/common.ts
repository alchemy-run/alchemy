import * as sqlvm from "@distilled.cloud/azure/sqlvirtualmachine";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

export const lower = (value: string | undefined) => value?.toLowerCase();

export const sameId = (a: string | undefined, b: string | undefined) =>
  lower(a) === lower(b);

/** Last segment of an ARM resource ID. */
export const nameOf = (armId: string) => armId.split("/").filter(Boolean).pop();

/** Replace `Redacted` leaves with their plain values (for the wire). */
export const unredact = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (Array.isArray(value)) return value.map(unredact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, unredact(v)]),
    );
  }
  return value;
};

/**
 * Canonical JSON (sorted keys, secrets unwrapped) for comparing write-only
 * settings Azure never returns against the previous props.
 */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(unredact(value), (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  ) ?? "undefined";

/**
 * Whether every field set in `desired` matches `observed`. Keys in `skip`
 * (write-only secrets Azure never returns) and `Redacted` values are
 * ignored; strings compare case-insensitively because ARM normalizes enum
 * casing.
 */
export const matchesObserved = (
  desired: unknown,
  observed: unknown,
  skip: ReadonlySet<string> = new Set(),
): boolean => {
  if (desired === undefined) return true;
  if (Redacted.isRedacted(desired)) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((d, i) => matchesObserved(d, observed[i], skip))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(
      ([key, value]) =>
        skip.has(key) ||
        matchesObserved(
          value,
          (observed as Record<string, unknown>)[key],
          skip,
        ),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return desired === observed;
};

export const getSqlVirtualMachineGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  sqlVirtualMachineGroupName: string,
) =>
  orUndefinedIfNotFound(
    sqlvm.GetSqlVirtualMachineGroup({
      subscriptionId,
      resourceGroupName,
      sqlVirtualMachineGroupName,
    }),
  );

/**
 * Whether the SQL VM group is tagged as owned by the current stack and
 * stage. Availability group listeners cannot carry tags and inherit
 * ownership from their group.
 */
export const isGroupOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  sqlVirtualMachineGroupName: string,
) {
  const group = yield* getSqlVirtualMachineGroup(
    subscriptionId,
    resourceGroupName,
    sqlVirtualMachineGroupName,
  );
  if (group === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(group.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});
