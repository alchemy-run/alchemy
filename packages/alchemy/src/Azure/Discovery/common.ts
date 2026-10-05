import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";

export { lower, sameLocation } from "../ContainerApps/common.ts";

/** The Microsoft Discovery resource provider namespace. */
export const DISCOVERY_NAMESPACE = "Microsoft.Discovery";

/**
 * Deterministic Microsoft Discovery name: every Discovery resource name must
 * match `^[a-zA-Z0-9-]{3,24}$`.
 */
export const createDiscoveryName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 24,
    lowercase: true,
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

/** Order-insensitive, case-insensitive key of a list of ARM IDs. */
export const idSetKey = (ids: ReadonlyArray<string> | undefined) =>
  (ids ?? [])
    .map((id) => id.toLowerCase())
    .sort()
    .join("|");

/** Key-sorted JSON, so equal JSON values compare equal. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  );

/** A list of user-assigned identity IDs as ARM's `{ [id]: {} }` map. */
export const toIdentityMap = (ids: ReadonlyArray<string> | undefined) =>
  ids === undefined || ids.length === 0
    ? undefined
    : Object.fromEntries(ids.map((id) => [id, {}]));
