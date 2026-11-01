/**
 * What the tokens and instances of STACKIT's AI services (`Stackit.ModelServing`,
 * `Stackit.ModelExperiments`) share. Both APIs answer labels the same way, and return a token's
 * value only from its create.
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  diffLabels,
  hasAlchemyLabels,
  hasInstanceLabel,
  labelRecord,
  stripInternalLabels,
} from "../Labels.ts";

/** Both specs reserve this prefix for STACKIT's own labels. */
const RESERVED_LABEL_PREFIX = "stackit";

/** Observed labels without the ones STACKIT itself manages. */
export const managedAiLabels = (labels: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(labelRecord(labels)).filter(([key]) => !key.startsWith(RESERVED_LABEL_PREFIX)),
  );

/** The labels a user set: neither STACKIT's nor Alchemy's. */
export const userAiLabels = (labels: unknown): Record<string, string> =>
  stripInternalLabels(managedAiLabels(labels));

/**
 * The `labels` of a PATCH taking observed labels to desired ones: `null` removes a key, as both
 * specs document. `undefined` when nothing drifted.
 */
export const labelPatch = (
  observed: unknown,
  desired: Record<string, string>,
): Record<string, string | null> | undefined => {
  const { upsert, removed } = diffLabels(managedAiLabels(observed), desired);
  if (upsert.length === 0 && removed.length === 0) return undefined;
  return {
    ...Object.fromEntries(upsert.map((tag) => [tag.Key, tag.Value])),
    ...Object.fromEntries(removed.map((key) => [key, null])),
  };
};

/** The first item labelled as this logical id, and as `generation` when one is given. */
export const findOwnedAiItem = <A extends { readonly labels?: unknown }>(
  id: string,
  items: ReadonlyArray<A>,
  generation: string | undefined,
) =>
  Effect.gen(function* () {
    for (const item of items) {
      if (
        (yield* hasAlchemyLabels(id, item.labels)) &&
        (generation === undefined || hasInstanceLabel(generation, item.labels))
      ) {
        return item;
      }
    }
    return undefined;
  });

/** A token's value as the API answered it, always `Redacted`. */
export const redactedValue = (
  value: string | Redacted.Redacted<string>,
): Redacted.Redacted<string> => (typeof value === "string" ? Redacted.make(value) : value);

/** Whether a token's `validUntil` has passed. Something that isn't a date hasn't passed. */
export const isPastValidUntil = (validUntil: string | undefined, now: number): boolean => {
  if (validUntil === undefined) return false;
  const time = new Date(validUntil).getTime();
  return !Number.isNaN(time) && time <= now;
};
