import { createInternalTags, diffTags, hasTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";

/**
 * STACKIT ownership labels.
 *
 * Alchemy brands every resource it creates with its stack, stage and
 * logical id (core `createInternalTags`: `alchemy::stack`, `alchemy::stage`,
 * `alchemy::id`). STACKIT label rules differ per API, so the markers are
 * mapped onto the strictest rule set, the Resource Manager's (projects and
 * folders), which every other API accepts:
 *
 * - **Key:** 1-63 characters, starts and ends with `[a-zA-Z0-9]`, contains
 *   only alphanumerics, `-`, `_` and `.` (an optional lowercase DNS prefix
 *   with `/` is allowed but not used). `alchemy::stack` becomes
 *   `alchemy.stack`.
 * - **Value:** at most 63 characters, empty or starting and ending with
 *   `[a-zA-Z0-9]`, containing only alphanumerics, `-`, `_` and `.`.
 *   Logical ids with `/` (nested scopes) become `__`, other characters `-`,
 *   and long values are truncated to 63 characters.
 *
 * IaaS labels are free-form JSON objects (the distilled type is `unknown`);
 * DNS zones take a `{ key, value }` list. {@link labelRecord} and
 * {@link toLabelList} / {@link fromLabelList} normalize both shapes.
 *
 * Diff desired labels against **observed** cloud labels with
 * {@link diffLabels}, never against `olds` or `output`, so adoption
 * converges.
 */
export const ALCHEMY_LABEL_PREFIX = "alchemy.";

/** The STACKIT label keys carrying Alchemy's ownership markers. */
export const alchemyLabelKeys = {
  stack: "alchemy.stack",
  stage: "alchemy.stage",
  id: "alchemy.id",
} as const;

const TAG_PREFIX = "alchemy::";

/** Map an Alchemy tag key (`alchemy::stack`) to its STACKIT label key. */
export const toLabelKey = (tagKey: string): string =>
  tagKey.startsWith(TAG_PREFIX)
    ? `${ALCHEMY_LABEL_PREFIX}${tagKey.slice(TAG_PREFIX.length)}`
    : tagKey;

/** Sanitize a label value to STACKIT's rules (see module docs). */
export const sanitizeLabelValue = (value: string): string => {
  if (value === "") return "";
  const cleaned = value
    .replaceAll("/", "__")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 63)
    .replace(/[^A-Za-z0-9]+$/, "");
  return cleaned.length > 0 ? cleaned : "x";
};

/**
 * Convert a tag map (user labels and/or Alchemy tags) into STACKIT labels:
 * Alchemy keys are renamed, every value is sanitized. User keys are passed
 * through unchanged; STACKIT rejects invalid user keys with a typed error.
 */
export const toLabels = (
  tags: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {})
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => [toLabelKey(key), sanitizeLabelValue(value)]),
  );

/**
 * Normalize observed labels from any STACKIT API into a string record:
 * a map (Resource Manager, Object Storage), a free-form object (IaaS, typed
 * `unknown` by distilled), or a `{ key, value }` list (DNS). Non-string
 * values are dropped.
 */
export const labelRecord = (labels: unknown): Record<string, string> => {
  if (labels === null || labels === undefined) return {};
  if (Array.isArray(labels)) return fromLabelList(labels);
  if (typeof labels !== "object") return {};
  return Object.fromEntries(
    Object.entries(labels).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
};

/** A label map as the `{ key, value }` list some APIs (DNS) take. */
export const toLabelList = (
  labels: Record<string, string>,
): Array<{ key: string; value: string }> =>
  Object.entries(labels).map(([key, value]) => ({ key, value }));

/** A `{ key, value }` label list (DNS) as a label map. */
export const fromLabelList = (
  labels: ReadonlyArray<unknown> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (labels ?? []).flatMap((label): Array<[string, string]> =>
      typeof label === "object" && label !== null && "key" in label && typeof label.key === "string"
        ? [[label.key, "value" in label && typeof label.value === "string" ? label.value : ""]]
        : [],
    ),
  );

/** Alchemy's ownership labels for logical id `id` in the current stack/stage. */
export const createInternalLabels = Effect.fn(function* (id: string) {
  return toLabels(yield* createInternalTags(id));
});

/**
 * Desired labels for a resource: the user's labels plus Alchemy's ownership
 * labels (ownership wins on a key clash).
 */
export const desiredLabels = Effect.fn(function* (
  id: string,
  userLabels: Record<string, string> | undefined,
) {
  const internal = yield* createInternalLabels(id);
  return { ...toLabels(userLabels), ...internal };
});

/** Drop Alchemy's ownership labels, leaving the user's. */
export const stripInternalLabels = (labels: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(labelRecord(labels)).filter(([key]) => !key.startsWith(ALCHEMY_LABEL_PREFIX)),
  );

/**
 * Whether observed labels mark the resource as the one Alchemy created for
 * logical id `id` in the current stack and stage. `read` returns
 * `Unowned(attrs)` when this is `false`.
 */
export const hasAlchemyLabels = Effect.fn(function* (id: string, labels: unknown) {
  const expected = yield* createInternalLabels(id);
  return hasTags(expected, labelRecord(labels));
});

/**
 * Whether observed labels carry any Alchemy ownership marker (any stack).
 * `list` uses it so `alchemy unsafe nuke` only enumerates resources Alchemy
 * created.
 */
export const isAlchemyOwned = (labels: unknown): boolean =>
  labelRecord(labels)[alchemyLabelKeys.stack] !== undefined;

/**
 * Diff observed cloud labels against desired labels (core `diffTags`).
 * Always pass **observed** labels as `observed` — never `olds.labels` or
 * `output.labels` — so adoption converges.
 */
export const diffLabels = (observed: unknown, desired: Record<string, string>) =>
  diffTags(labelRecord(observed), desired);

/** Whether observed labels differ from desired labels at all. */
export const labelsChanged = (observed: unknown, desired: Record<string, string>): boolean => {
  const { upsert, removed } = diffLabels(observed, desired);
  return upsert.length > 0 || removed.length > 0;
};
