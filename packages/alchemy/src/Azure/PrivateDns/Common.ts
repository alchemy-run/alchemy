import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { WaitBudget } from "../Arm.ts";
import { stackAndStage } from "../Arm.ts";

/** Private DNS zones and links are global resources. */
export const GLOBAL = "global";

/** Zones, links, and record sets converge in seconds to a few minutes. */
export const PRIVATE_DNS_BUDGET: WaitBudget = {
  interval: "3 seconds",
  times: 100,
};

/** ARM names, IDs, and locations compare case-insensitively. */
export const sameArm = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/**
 * Deleting a zone right after its virtual network links were deleted can
 * fail with `CannotDeleteResource` until ARM catches up.
 */
export const whileLinksExist = {
  while: (e: { readonly _tag: string }) => e._tag === "CannotDeleteResource",
  schedule: Schedule.spaced("10 seconds"),
  times: 18,
} as const;

/**
 * Private DNS silently drops tag keys containing `:` (zones, links) and
 * record-set metadata keys must be alphanumeric/underscore, so Alchemy
 * ownership markers use `alchemy_*` keys instead of the `alchemy::*` tags.
 */
const MARKER_PREFIX = "alchemy_";

/** Desired tags/metadata: the user's entries plus ownership markers. */
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

/** Whether observed tags/metadata carry this stack/stage/id's markers. */
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

/** Whether tags/metadata carry any Alchemy ownership marker (used by `list`). */
export const hasAnyMarker = (
  metadata: Record<string, string | undefined> | undefined,
) => metadata !== undefined && "alchemy_stack" in metadata;

/** User-facing tags/metadata (ownership markers stripped). */
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
