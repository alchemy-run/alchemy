/**
 * Shared helpers for the `resources` service (Microsoft.Resources,
 * Microsoft.Authorization policy/locks, Microsoft.Solutions). Not exported
 * from any namespace barrel.
 */
import * as Effect from "effect/Effect";
import { createInternalTags } from "../../Tags.ts";

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

/** Case-insensitive ARM id / name comparison. */
export const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").replace(/\/+$/, "").toLowerCase() ===
  (b ?? "").replace(/\/+$/, "").toLowerCase();

/** Metadata members ARM stamps on policy objects by itself. */
const SERVER_METADATA = new Set([
  "createdBy",
  "createdOn",
  "updatedBy",
  "updatedOn",
]);

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Desired metadata for untaggable policy objects: the user's metadata plus
 * the Alchemy ownership entries (`alchemy::stack`, `alchemy::stage`,
 * `alchemy::id`).
 */
export const metadataWithMarker = Effect.fn(function* (
  id: string,
  metadata: Record<string, unknown> | undefined,
) {
  return { ...metadata, ...(yield* createInternalTags(id)) } as Record<
    string,
    unknown
  >;
});

/** Observed metadata without the members ARM adds on its own. */
export const comparableMetadata = (
  metadata: unknown,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(asRecord(metadata)).filter(
      ([key]) => !SERVER_METADATA.has(key),
    ),
  );

/** User metadata: no server-stamped members and no ownership entries. */
export const userMetadata = (metadata: unknown): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(comparableMetadata(metadata)).filter(
      ([key]) => !key.startsWith("alchemy::"),
    ),
  );

/** String-valued metadata entries, for the tag-based ownership helpers. */
export const metadataTags = (metadata: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(asRecord(metadata)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

/** `{ name: value }` → ARM parameter values `{ name: { value } }`. */
export const toParameterValues = (
  parameters: Record<string, unknown> | undefined,
): Record<string, { value: unknown }> | undefined =>
  parameters === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(parameters).map(([key, value]) => [key, { value }]),
      );

/** ARM parameter values `{ name: { value } }` → `{ name: value }`. */
export const fromParameterValues = (
  parameters: unknown,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(asRecord(parameters)).map(([key, value]) => [
      key,
      asRecord(value).value,
    ]),
  );
