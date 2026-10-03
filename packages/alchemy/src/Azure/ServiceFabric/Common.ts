import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import type { WaitBudget } from "../Arm.ts";

/**
 * Generate a Service Fabric managed cluster name. The name doubles as the
 * cluster's default DNS label (`{name}.{region}.cloudapp.azure.com`), so it
 * is lowercase letters, digits, and `-`, 4-23 characters, starting with a
 * letter.
 */
export const createClusterName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 23,
    lowercase: true,
  });
  const cleaned = name.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(cleaned) ? cleaned : `c${cleaned.slice(0, 22)}`;
});

/**
 * Generate a node type name. Without `computerNamePrefix` the node type
 * name becomes the VM computer-name prefix, which Windows caps at 9
 * characters; it must start with a letter.
 */
export const createNodeTypeName = Effect.fn(function* (id: string) {
  return yield* createPhysicalName({
    id,
    prefix: "nt",
    suffixLength: 7,
    maxLength: 9,
    lowercase: true,
    delimiter: "",
  });
});

/**
 * Generate an application or service name: letters, digits, and `-`,
 * starting with a letter.
 */
export const createFabricChildName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 63 });
  const cleaned = name.replace(/[^a-zA-Z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-zA-Z]/.test(cleaned) ? cleaned : `a${cleaned.slice(0, 62)}`;
});

/** ARM names, IDs, and locations compare case-insensitively. */
export const sameArm = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/**
 * Whether every field set in `desired` matches `observed`. Fields the
 * caller left unset are not compared (Azure fills in defaults); strings
 * compare case-insensitively because the RP normalizes enum casing.
 */
export const matches = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((value, i) => matches(value, observed[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(([key, value]) =>
      matches(value, (observed as Record<string, unknown>)[key]),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return desired === observed;
};

/** Field names among `desired` whose values differ from `observed`. */
export const driftedFields = (
  desired: Record<string, unknown>,
  observed: Record<string, unknown> | undefined,
) =>
  Object.keys(desired).filter((key) => !matches(desired[key], observed?.[key]));

/**
 * Clusters and node types take 10-40 minutes to provision, scale, and
 * delete (VM scale sets, load balancers, and the Service Fabric runtime).
 */
export const CLUSTER_BUDGET: WaitBudget = { interval: "40 seconds", times: 60 };

/** Applications, application types, versions, and services. */
export const APP_BUDGET: WaitBudget = { interval: "10 seconds", times: 60 };
