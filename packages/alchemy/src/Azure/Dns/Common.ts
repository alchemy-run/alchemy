import * as Effect from "effect/Effect";
import type { WaitBudget } from "../Arm.ts";
import { stackAndStage } from "../Arm.ts";

/** Public DNS zones are global resources. */
export const GLOBAL = "global";

/** Zones and record sets converge in seconds; zone deletes take ~1 minute. */
export const DNS_BUDGET: WaitBudget = {
  interval: "3 seconds",
  times: 60,
};

/** ARM names, IDs, and locations compare case-insensitively. */
export const sameArm = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/**
 * Azure DNS silently drops zone tag keys containing `:` and record-set
 * metadata keys must be alphanumeric/underscore, so Alchemy ownership
 * markers use `alchemy_*` keys instead of the `alchemy::*` tags.
 */
const MARKER_PREFIX = "alchemy_";

/** Desired zone tags / record-set metadata: the user's entries plus ownership markers. */
export const desiredMetadata = Effect.fn(function* (
  id: string,
  metadata: Record<string, string> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  return {
    ...metadata,
    alchemy_stack: stack,
    alchemy_stage: stage,
    alchemy_id: id,
  } as Record<string, string>;
});

/** Whether observed metadata carries this stack/stage/id's markers. */
export const ownsMetadata = Effect.fn(function* (
  id: string,
  metadata: Record<string, string | undefined> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  return (
    metadata?.alchemy_stack === stack &&
    metadata?.alchemy_stage === stage &&
    metadata?.alchemy_id === id
  );
});

/** Whether metadata carries any Alchemy ownership marker (used by `list`). */
export const hasAnyMarker = (
  metadata: Record<string, string | undefined> | undefined,
) => metadata !== undefined && "alchemy_stack" in metadata;

/** User-facing metadata (ownership markers stripped). */
export const userMetadata = (
  metadata: Record<string, string | undefined> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith(MARKER_PREFIX),
    ),
  );

/** Key-order-insensitive comparison of two string maps. */
export const sameMap = (
  a: Record<string, string | undefined> | undefined,
  b: Record<string, string | undefined> | undefined,
) => {
  const norm = (m: Record<string, string | undefined> | undefined) =>
    JSON.stringify(
      Object.entries(m ?? {})
        .filter(([, v]) => v !== undefined)
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
    );
  return norm(a) === norm(b);
};
