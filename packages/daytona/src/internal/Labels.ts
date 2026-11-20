import { createInternalTags, hasTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";

/**
 * Daytona sandbox labels carry alchemy's ownership tags. Tag keys
 * (`alchemy::stack`) are written as `alchemy.stack` to stay within the
 * conservative key alphabet every label API accepts.
 */
export const ALCHEMY_LABEL_PREFIX = "alchemy.";
const TAG_PREFIX = "alchemy::";

export const toLabelKey = (key: string) =>
  key.startsWith(TAG_PREFIX) ? `${ALCHEMY_LABEL_PREFIX}${key.slice(TAG_PREFIX.length)}` : key;

export const toLabels = (tags: Record<string, string> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(tags ?? {}).map(([k, v]) => [toLabelKey(k), v]));

export const createInternalLabels = Effect.fn(function* (id: string) {
  return toLabels(yield* createInternalTags(id));
});

/** A label map as Daytona returns it (values typed optional). */
export type LabelMap = { readonly [key: string]: string | undefined };

/** Drop undefined values from a label map. */
export const definedLabels = (labels: LabelMap | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries(labels ?? {}).filter((e): e is [string, string] => e[1] !== undefined),
  );

export const hasAlchemyLabels = Effect.fn(function* (id: string, labels: LabelMap | undefined) {
  return hasTags(yield* createInternalLabels(id), definedLabels(labels));
});

/** Labels without alchemy's ownership keys: what the user declared. */
export const userLabels = (labels: LabelMap | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries(definedLabels(labels)).filter(([k]) => !k.startsWith(ALCHEMY_LABEL_PREFIX)),
  );
