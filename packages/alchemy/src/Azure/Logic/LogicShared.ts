import * as crypto from "node:crypto";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { createInternalTags } from "../../Tags.ts";
import { isOwned } from "../Arm.ts";

/**
 * Shared scaffolding for Logic Apps resources. Not exported from the
 * service index.
 */

/**
 * Generated name for workflows, integration accounts, and integration
 * account artifacts: 1-80 letters, digits, `-`, `_`, `.`, `(`, `)`.
 */
export const createLogicName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 80 });
  return name.replace(/[^A-Za-z0-9\-_.()]/g, "-");
});

const INTERNAL_PREFIX = "alchemy::";

/**
 * Integration account artifacts accept `tags` but never echo them back, so
 * Alchemy records ownership (and a hash of write-only content) as
 * `alchemy::*` keys in the artifact's `metadata` object.
 */
export const artifactMetadata = Effect.fn(function* (
  id: string,
  metadata: Record<string, unknown> | undefined,
  extra: Record<string, string> = {},
) {
  const user = Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      ([key]) => !key.startsWith(INTERNAL_PREFIX),
    ),
  );
  return { ...user, ...extra, ...(yield* createInternalTags(id)) };
});

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Observed metadata with Alchemy's `alchemy::*` keys stripped. */
export const userMetadata = (metadata: unknown): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(asRecord(metadata)).filter(
      ([key]) => !key.startsWith(INTERNAL_PREFIX),
    ),
  );

/** Whether observed artifact metadata carries this stack/stage/id's markers. */
export const isOwnedByMetadata = (id: string, metadata: unknown) =>
  isOwned(
    id,
    Object.fromEntries(
      Object.entries(asRecord(metadata)).flatMap(([key, value]) =>
        typeof value === "string" ? [[key, value]] : [],
      ),
    ),
  );

/** Sorted-key JSON with `undefined` members dropped. */
const canonical = (value: unknown): string =>
  JSON.stringify(value ?? null, (_key, inner) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner,
  );

/**
 * Key under which Alchemy records a hash of the desired configuration
 * (in tags or artifact metadata). Azure never echoes some fields (schema
 * and map content) and fills in defaults on others, so the hash is how a
 * removed or changed field is detected; observed fields are still compared
 * to catch out-of-band drift.
 */
export const HASH_KEY = "alchemy::hash";

/** SHA-256 of the canonical JSON of `value`. */
export const hashOf = (value: unknown) =>
  Effect.sync(() =>
    crypto.createHash("sha256").update(canonical(value)).digest("hex"),
  );

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && Object.keys(value as object).length === 0);

/**
 * Whether `observed` contains everything in `desired`. ARM echoes Logic
 * definitions and settings back with server-side defaults added, so extra
 * observed keys are not a difference. Strings compare case-sensitively.
 */
export const contains = (observed: unknown, desired: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((value, i) => contains(observed[i], value))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    if (Array.isArray(observed)) return false;
    const record = observed as Record<string, unknown>;
    return Object.entries(desired as Record<string, unknown>).every(
      ([key, value]) => contains(record[key], value),
    );
  }
  return observed === desired;
};

/**
 * True when observed properties differ from the desired ones. Every key of
 * `desired` is managed: a desired `undefined` differs from a non-empty
 * observed value (the field was removed).
 */
export const propertiesDiffer = (
  desired: Record<string, unknown>,
  observed: object | undefined,
) => {
  if (observed === undefined) return true;
  const record = observed as Record<string, unknown>;
  return Object.keys(desired).some((key) =>
    desired[key] === undefined
      ? !isEmpty(record[key])
      : !contains(record[key], desired[key]),
  );
};

/** Drop `undefined` members (fields Azure derives when left unset). */
export const definedOnly = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value).filter(([, inner]) => inner !== undefined),
  );

/**
 * Whether an observed integration account artifact must be rewritten: its
 * metadata lacks the desired ownership markers or
 * configuration hash, or an observed property differs from `compare`.
 */
export const artifactDiffers = (
  observed: { metadata?: unknown },
  metadata: Record<string, unknown>,
  compare: Record<string, unknown>,
) =>
  !contains(observed.metadata, metadata) || propertiesDiffer(compare, observed);
