/**
 * Shared helpers for the `deviceregistry` service (Microsoft.DeviceRegistry).
 * Not exported from the namespace barrel.
 */
import * as deviceregistry from "@distilled.cloud/azure/deviceregistry";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  hasAnyAlchemyTag,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  type WaitBudget,
} from "../Arm.ts";

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
  JSON.stringify(normalize(value)) ?? "undefined";

/** Unwrap redacted values and sort object keys, dropping `undefined` members. */
const normalize = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        .map(([k, x]) => [k, normalize(x)]),
    );
  }
  return value;
};

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

/**
 * Alchemy-owned Device Registry namespaces in the subscription, used to
 * enumerate their child devices and assets.
 */
export const listOwnedNamespaces = Effect.fn(function* (
  subscriptionId: string,
) {
  const page = yield* orUndefinedIfNotFound(
    deviceregistry
      .ListNamespaceBySubscription({ subscriptionId })
      .pipe(
        Effect.flatMap((page) =>
          requireSinglePage("ListNamespaceBySubscription", page),
        ),
      ),
  );
  return (page?.value ?? []).flatMap((ns) => {
    const resourceGroup = resourceGroupOf(ns.id);
    return hasAnyAlchemyTag(ns.tags) &&
      resourceGroup !== undefined &&
      ns.name !== undefined
      ? [{ resourceGroup, name: ns.name }]
      : [];
  });
});
