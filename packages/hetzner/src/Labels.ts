import { createInternalTags, diffTags, hasTags, type Tags } from "alchemy/Tags";
import * as Effect from "effect/Effect";

/**
 * Hetzner label keys cannot contain `:`. Alchemy ownership tags use
 * `alchemy::stack` / `alchemy::stage` / `alchemy::id` — map those onto
 * `alchemy.stack` / `alchemy.stage` / `alchemy.id` so they survive the
 * Cloud API, and invert the mapping when reading observed labels back.
 *
 * Label values must match `^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$`
 * (or be empty). FQNs that contain `/` are rewritten to `__`.
 */
export const ALCHEMY_LABEL_PREFIX = "alchemy.";

export const alchemyLabelKeys = {
  stack: "alchemy.stack",
  stage: "alchemy.stage",
  id: "alchemy.id",
} as const;

/**
 * Hetzner `label_selector` matching any resource Alchemy stamped with
 * `alchemy.stack`. Used by `list` so nuke only enumerates our rows.
 */
export const alchemyStackSelector = alchemyLabelKeys.stack;

const TAG_PREFIX = "alchemy::";

export const toLabelKey = (tagKey: string): string =>
  tagKey.startsWith(TAG_PREFIX)
    ? `${ALCHEMY_LABEL_PREFIX}${tagKey.slice(TAG_PREFIX.length)}`
    : tagKey;

export const toTagKey = (labelKey: string): string =>
  labelKey.startsWith(ALCHEMY_LABEL_PREFIX)
    ? `${TAG_PREFIX}${labelKey.slice(ALCHEMY_LABEL_PREFIX.length)}`
    : labelKey;

export const sanitizeLabelValue = (value: string): string => {
  const cleaned = value
    .replaceAll("/", "__")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .slice(0, 63)
    .replace(/[^A-Za-z0-9]+$/g, "");
  return cleaned.length > 0 ? cleaned : "x";
};

export const toLabels = (tags: Record<string, string> | null | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).map(([key, value]) => [toLabelKey(key), sanitizeLabelValue(value)]),
  );

export const fromLabels = (
  labels: Record<string, string> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(Object.entries(labels ?? {}).map(([key, value]) => [toTagKey(key), value]));

export const createInternalLabels = Effect.fn(function* (id: string) {
  return toLabels(yield* createInternalTags(id));
});

export const stripInternalLabels = (
  labels: Record<string, string> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(labels ?? {}).filter(([key]) => !key.startsWith(ALCHEMY_LABEL_PREFIX)),
  );

export const hasAlchemyLabels = Effect.fn(function* (id: string, labels: Tags | undefined) {
  const expected = yield* createInternalLabels(id);
  return hasTags(expected, labels);
});

/**
 * Diff observed cloud labels against desired labels. Always pass
 * **observed** labels as `oldLabels` — never `olds.labels` or
 * `output.labels` — so adoption converges.
 */
export const diffLabels = diffTags;

/**
 * Hetzner label-selector string for a label map (`key=value,key=value`).
 */
export const labelSelector = (labels: Record<string, string>): string =>
  Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");

/**
 * Whether a resource `read` found is the generation a replacement replaces,
 * rather than the replacement's own identity. Ownership labels name the
 * logical resource, not a generation, so a label lookup during a
 * replacement's identity check (`previous` set) finds the old generation.
 * It is the replacement's identity only when the replacement claims the
 * same explicit name; otherwise `read` reports nothing there and reconcile
 * creates the new generation.
 */
export const isReplacedGeneration = (args: {
  readonly previousId: unknown;
  readonly foundId: unknown;
  readonly claimedName?: string | undefined;
  readonly foundName?: string | undefined;
}): boolean =>
  args.previousId !== undefined &&
  args.previousId === args.foundId &&
  (args.claimedName === undefined || args.claimedName !== args.foundName);

/**
 * Whether a replacement keeps the explicit name of the generation it
 * replaces. Hetzner names are unique per project, so such a replacement
 * can't be created next to the old generation: it deletes it first.
 */
export const keepsName = (
  news: { readonly name?: string | undefined },
  output: { readonly name: string },
): boolean => news.name !== undefined && news.name === output.name;
