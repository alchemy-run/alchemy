import * as web from "@distilled.cloud/azure/web";
import { tagRecord } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Lowercase an optional string, for case-insensitive ARM comparisons. */
export const lower = (value: string | undefined) => value?.toLowerCase();

/** Compare Azure locations, ignoring case and spaces (`East US` = `eastus`). */
export const sameLocation = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase().replaceAll(" ", "") === b?.toLowerCase().replaceAll(" ", "");

/** Name segment of an ARM resource ID, e.g. the plan name of a `serverFarmId`. */
export const nameOf = (armId: string | undefined) =>
  armId
    ?.split("/")
    .filter((part) => part.length > 0)
    .pop();

/** Request address of a site (`sites/{name}`) for site child operations. */
export const siteWhere = (subscriptionId: string, resourceGroup: string, siteName: string) => ({
  subscriptionId,
  resourceGroupName: resourceGroup,
  name: siteName,
});

/**
 * Whether the app (or slot) carries this stack/stage's ownership tags.
 * Untagged per-app singletons (policies that always exist) take their
 * ownership from the app they configure.
 */
export const isSiteOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
) {
  const where = siteWhere(subscriptionId, resourceGroup, siteName);
  const site = yield* orUndefinedIfNotFound(
    slot === undefined ? web.GetWebApp(where) : web.GetWebAppSlot({ ...where, slot }),
  );
  if (site === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(site.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

/** Unwrap a secret prop that may be given as plain text or `Redacted`. */
export const reveal = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;

/**
 * Whether the observed JSON value satisfies the desired one. Objects match
 * when every desired key matches (Azure echoes extra defaults back), arrays
 * element-wise, strings case-insensitively (ARM normalizes casing).
 */
export const matchesDesired = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((item, i) => matchesDesired(item, observed[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    const record = observed as Record<string, unknown>;
    return Object.entries(desired as Record<string, unknown>).every(([key, value]) =>
      matchesDesired(value, record[key]),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return desired === observed;
};

/** Whether an observed settings map equals the desired one exactly. */
export const settingsMatch = (
  desired: Record<string, string>,
  observed: Record<string, string | undefined> | undefined,
) => {
  const have = observed ?? {};
  const keys = new Set([...Object.keys(desired), ...Object.keys(have)]);
  return [...keys].every((key) => desired[key] === have[key]);
};

/** The desired keys whose value the observed object does not satisfy. */
export const changedKeys = <T extends object>(
  desired: T,
  observed: object | undefined,
): Partial<T> => {
  const record = (observed ?? {}) as Record<string, unknown>;
  const changed: Partial<T> = {};
  for (const key of Object.keys(desired) as (keyof T & string)[]) {
    const value = desired[key];
    if (value !== undefined && !matchesDesired(value, record[key])) {
      changed[key] = value;
    }
  }
  return changed;
};
