import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";

/*
 * Shared, un-exported helpers for the StorageSync resources. Not
 * re-exported from `index.ts`.
 */

export const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/**
 * Name for a Storage Sync child (sync group, cloud/server endpoint):
 * letters, digits, `-`, `_`, `.`; starts and ends with a letter or digit.
 */
export const createChildName = Effect.fn(function* (
  id: string,
  maxLength: number,
) {
  const name = yield* createPhysicalName({ id, maxLength, lowercase: true });
  return name
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
});
