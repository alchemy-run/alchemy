/**
 * Stripe has no tagging API — every object instead carries a free-form
 * `metadata` map (keys ≤ 40 chars, values ≤ 500 chars, max 50 entries).
 * Alchemy brands the objects it owns by writing three reserved keys into
 * that map, which is how `read` re-discovers a resource whose state row was
 * lost and how adoption decides whether an existing object is ours.
 *
 * Colons are not reliably accepted in Stripe metadata keys, so the internal
 * keys use `alchemy_*` rather than the `alchemy::*` convention used by the
 * tag-based clouds.
 */
import * as Effect from "effect/Effect";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";

export const ALCHEMY_STACK_KEY = "alchemy_stack";
export const ALCHEMY_STAGE_KEY = "alchemy_stage";
export const ALCHEMY_ID_KEY = "alchemy_id";

const INTERNAL_KEYS = [
  ALCHEMY_STACK_KEY,
  ALCHEMY_STAGE_KEY,
  ALCHEMY_ID_KEY,
] as const;

export type Metadata = Record<string, string>;

/**
 * The reserved `alchemy_*` metadata entries identifying the stack, stage and
 * logical ID that own a Stripe object.
 */
export const internalMetadata = Effect.fn(function* (id: string) {
  const stack = yield* Stack;
  const stage = yield* Stage;
  return {
    [ALCHEMY_STACK_KEY]: stack.name,
    [ALCHEMY_STAGE_KEY]: stage,
    [ALCHEMY_ID_KEY]: id,
  } satisfies Metadata;
});

/** Merge the user's metadata with alchemy's branding (branding wins). */
export const brandMetadata = Effect.fn(function* (
  id: string,
  userMetadata: Metadata | undefined,
) {
  return { ...(userMetadata ?? {}), ...(yield* internalMetadata(id)) };
});

/**
 * Narrow a Stripe metadata map to {@link Metadata}.
 *
 * Distilled types every metadata value as `string | undefined` (the schema is
 * a plain `Record(String, String)` widened at codegen), so an observed map is
 * not directly assignable to `Record<string, string>`. Dropping the
 * `undefined` values is safe: Stripe never returns one, and posting an empty
 * string is how a key is unset.
 */
export const toMetadata = (
  metadata: { readonly [key: string]: string | undefined } | null | undefined,
): Metadata => {
  const out: Metadata = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

/** Strip the reserved `alchemy_*` entries, leaving only user metadata. */
export const stripInternalMetadata = (
  metadata: Metadata | null | undefined,
): Metadata =>
  Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      ([key]) => !INTERNAL_KEYS.includes(key as (typeof INTERNAL_KEYS)[number]),
    ),
  );

/** Whether an observed Stripe object carries this stack/stage/id branding. */
export const isOwnedBy = (
  id: string,
  stackName: string,
  stage: string,
  metadata: Metadata | null | undefined,
): boolean =>
  metadata?.[ALCHEMY_STACK_KEY] === stackName &&
  metadata?.[ALCHEMY_STAGE_KEY] === stage &&
  metadata?.[ALCHEMY_ID_KEY] === id;

/**
 * Whether an observed object is branded for this stack/stage/id, resolving
 * the stack + stage from context.
 */
export const isOwned = Effect.fn(function* (
  id: string,
  metadata: Metadata | null | undefined,
) {
  const stack = yield* Stack;
  const stage = yield* Stage;
  return isOwnedBy(id, stack.name, stage, metadata);
});

/**
 * Stripe's `metadata` update semantics: posting an empty string unsets a key,
 * and omitted keys are left untouched. To converge observed → desired we must
 * therefore explicitly blank every key that disappeared.
 */
export const metadataUpdate = (
  observed: Metadata | null | undefined,
  desired: Metadata,
): Metadata => {
  const update: Metadata = { ...desired };
  for (const key of Object.keys(observed ?? {})) {
    if (!(key in desired)) update[key] = "";
  }
  return update;
};

/** Structural equality over two metadata maps. */
export const metadataEqual = (
  a: Metadata | null | undefined,
  b: Metadata | null | undefined,
): boolean => {
  const left = a ?? {};
  const right = b ?? {};
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => left[key] === right[key]);
};
