import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";

/**
 * Name for an Azure Managed Lustre resource (file system or job):
 * alphanumerics, `_` and `-`, starting and ending with an alphanumeric,
 * at most `maxLength` characters.
 */
export const createLustreName = Effect.fn(function* (
  id: string,
  maxLength = 80,
) {
  const name = yield* createPhysicalName({ id, maxLength });
  return name.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
});

/**
 * Azure Managed Lustre file systems take 10-30 minutes to create and
 * 5-20 minutes to delete; poll every 30 seconds for up to 60 minutes.
 */
export const FILESYSTEM_BUDGET = {
  interval: "30 seconds",
  times: 120,
} as const;

/** Polling budget for auto import/export jobs (minutes, not seconds). */
export const JOB_BUDGET = { interval: "10 seconds", times: 60 } as const;

/** Normalize an Azure location for comparison (`East US` = `eastus`). */
export const sameLocation = (a: string, b: string) =>
  a.toLowerCase().replaceAll(" ", "") === b.toLowerCase().replaceAll(" ", "");

/** Order-sensitive string list equality (prefix lists). */
export const sameList = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** A job's parent AML file system does not exist (needed for its location). */
export class AmlFilesystemMissing extends Data.TaggedError(
  "Azure.StorageCache.AmlFilesystemMissing",
)<{ readonly amlFilesystem: string; readonly message: string }> {}
