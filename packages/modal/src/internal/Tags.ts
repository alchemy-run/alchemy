import { createInternalTags, hasTags, type Tags } from "alchemy/Tags";
import * as Effect from "effect/Effect";

/**
 * Modal tag keys and values must match `^[a-zA-Z0-9._-]{1,63}$`, so
 * Alchemy's `alchemy::stack` / `alchemy::stage` / `alchemy::id` ownership
 * tags are stored as `alchemy.stack` / `alchemy.stage` / `alchemy.id`, and
 * their values are rewritten into that character set (`/` in a nested
 * logical ID becomes `__`).
 */
export const ALCHEMY_TAG_PREFIX = "alchemy.";

const INTERNAL_PREFIX = "alchemy::";

const toModalKey = (key: string): string =>
  key.startsWith(INTERNAL_PREFIX)
    ? `${ALCHEMY_TAG_PREFIX}${key.slice(INTERNAL_PREFIX.length)}`
    : key;

const toModalValue = (value: string): string => {
  const cleaned = value
    .replaceAll("/", "__")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 63);
  return cleaned.length > 0 ? cleaned : "-";
};

/** Alchemy's ownership tags in Modal's tag format. */
export const createModalInternalTags = Effect.fn(function* (id: string) {
  const tags = yield* createInternalTags(id);
  return Object.fromEntries(
    Object.entries(tags).map(([key, value]) => [toModalKey(key), toModalValue(value)]),
  );
});

/** Whether observed Modal tags carry this resource's ownership tags. */
export const hasModalAlchemyTags = Effect.fn(function* (id: string, tags: Tags | undefined) {
  return hasTags(yield* createModalInternalTags(id), tags);
});

/** Whether observed Modal tags carry any Alchemy ownership tag. */
export const isAlchemyTagged = (
  tags: Readonly<Record<string, string | undefined>> | undefined,
): boolean => Object.keys(tags ?? {}).some((key) => key.startsWith(ALCHEMY_TAG_PREFIX));
