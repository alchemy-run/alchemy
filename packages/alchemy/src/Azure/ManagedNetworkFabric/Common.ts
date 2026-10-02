import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { stackAndStage, type WaitBudget, waitForProvisioned } from "../Arm.ts";

/** Resource provider namespace of Azure Operator Nexus Network Fabric. */
export const FABRIC_NAMESPACE = "Microsoft.ManagedNetworkFabric";

/**
 * Generate a Network Fabric resource name. The RP enforces
 * `^[a-zA-Z][a-zA-Z0-9-_]{2,127}$`: 3-128 letters, digits, `_`, and `-`,
 * starting with a letter.
 */
export const createFabricName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 80 });
  return name
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^[^a-zA-Z]+|[^a-zA-Z0-9]+$/g, "");
});

/** ARM names, IDs, and locations compare case-insensitively. */
export const sameArm = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/**
 * Network Fabric configuration objects move through `Accepted` →
 * `Creating`/`Updating` → `Succeeded` within a minute or two.
 */
export const FABRIC_BUDGET: WaitBudget = { interval: "5 seconds", times: 60 };

/** Poll a Network Fabric GET until `properties.provisioningState` succeeds. */
export const waitFabricProvisioned = <
  A extends { readonly properties?: { readonly provisioningState?: string } },
  E,
  R,
>(
  label: string,
  get: Effect.Effect<A | undefined, E, R>,
  budget: WaitBudget = FABRIC_BUDGET,
) =>
  waitForProvisioned(
    label,
    get,
    (value) => value.properties?.provisioningState,
    budget,
  );

/**
 * Whether `observed` already carries everything in `desired`. Objects are
 * compared by the keys `desired` sets (the service adds defaults and
 * read-only fields), arrays element by element, and strings
 * case-insensitively (ARM IDs and enum values come back re-cased).
 */
export const contains = (observed: unknown, desired: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((value, index) => contains(observed[index], value))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    if (Array.isArray(observed)) return false;
    const record = observed as Record<string, unknown>;
    return Object.entries(desired).every(([key, value]) =>
      contains(record[key], value),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return observed === desired;
};

/**
 * The desired fields that differ from the observed properties, or
 * `undefined` when everything is in sync. Fields left `undefined` in
 * `desired` are not managed and never produce a delta.
 */
export const propertyDelta = <T extends object>(
  observed: object | undefined,
  desired: T,
): Partial<T> | undefined => {
  const record = (observed ?? {}) as Record<string, unknown>;
  const delta: Partial<T> = {};
  let changed = false;
  for (const key of Object.keys(desired) as (keyof T & string)[]) {
    const value = desired[key];
    if (value !== undefined && !contains(record[key], value)) {
      delta[key] = value;
      changed = true;
    }
  }
  return changed ? delta : undefined;
};

/** Order- and case-sensitive structural inequality of two prop values. */
export const differs = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);

/**
 * Ownership marker written to `properties.annotation` of child (proxy)
 * resources, which carry no ARM tags.
 */
export const annotationMarker = Effect.fn(function* (id: string) {
  const { stack, stage } = yield* stackAndStage;
  return `alchemy:${stack}/${stage}/${id}`;
});

/** Whether a child resource's annotation carries any Alchemy marker. */
export const hasAlchemyMarker = (annotation: string | undefined) =>
  annotation?.startsWith("alchemy:") ?? false;
