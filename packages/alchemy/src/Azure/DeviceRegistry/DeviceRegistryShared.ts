/**
 * Shared helpers for the `deviceregistry` service (Microsoft.DeviceRegistry).
 * Not exported from the namespace barrel.
 */
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import type { WaitBudget } from "../Arm.ts";

/** Resource provider namespace registered at the top of every reconcile. */
export const DEVICE_REGISTRY_RP = "Microsoft.DeviceRegistry";

/** Provisioning budget for Device Registry long-running operations. */
export const DEVICE_REGISTRY_WAIT: WaitBudget = {
  interval: "5 seconds",
  times: 72,
};

/**
 * Lowercase name of letters, digits, and single hyphens that starts and
 * ends with a letter or digit — valid for every Device Registry type.
 */
export const createDeviceRegistryName = Effect.fn(function* (
  id: string,
  maxLength = 63,
) {
  const name = yield* createPhysicalName({
    id,
    maxLength,
    lowercase: true,
    delimiter: "-",
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
});

/**
 * Structural equality for plain JSON values with object keys compared in
 * sorted order and `undefined` members dropped.
 */
export const sameJson = (a: unknown, b: unknown): boolean =>
  canonical(a) === canonical(b);

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
        )
      : v,
  ) ?? "undefined";

/**
 * The keys of `desired` (defined values only) whose observed value differs.
 * Used to send only the delta of user-set properties.
 */
export const changedKeys = <T extends object>(
  desired: T,
  observed: object | undefined,
): (keyof T)[] =>
  (Object.keys(desired) as (keyof T)[]).filter(
    (key) =>
      desired[key] !== undefined &&
      !sameJson(desired[key], (observed as Record<keyof T, unknown>)?.[key]),
  );

/** Case-insensitive comparison of names, groups, and locations. */
export const sameName = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** Location comparison that ignores case and spaces (`East US` = `eastus`). */
export const sameLocation = (a: string | undefined, b: string | undefined) =>
  (a ?? "").replace(/\s/g, "").toLowerCase() ===
  (b ?? "").replace(/\s/g, "").toLowerCase();
