import * as Effect from "effect/Effect";
import { stackAndStage } from "../Arm.ts";

/**
 * Traffic Manager silently drops tag keys containing `:`, so Alchemy's
 * `alchemy::*` ownership tags are stored as `alchemy_*` tags instead.
 */
const MARKER_PREFIX = "alchemy_";

/** Desired profile tags: the user's tags plus ownership markers. */
export const desiredProfileTags = Effect.fn(function* (
  id: string,
  tags: Record<string, string> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  return {
    ...tags,
    alchemy_stack: stack,
    alchemy_stage: stage,
    alchemy_id: id,
  } as Record<string, string>;
});

/** Whether profile tags carry this stack/stage/id's markers. */
export const ownsProfile = Effect.fn(function* (
  id: string,
  tags: Record<string, string | undefined> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  return (
    tags?.alchemy_stack === stack &&
    tags?.alchemy_stage === stage &&
    tags?.alchemy_id === id
  );
});

/** Whether profile tags carry this stack's and stage's markers. */
export const ownedByStack = Effect.fn(function* (
  tags: Record<string, string | undefined> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  return tags?.alchemy_stack === stack && tags?.alchemy_stage === stage;
});

/** Whether profile tags carry any Alchemy marker (used by `list`). */
export const hasAnyProfileMarker = (
  tags: Record<string, string | undefined> | undefined,
) => tags !== undefined && "alchemy_stack" in tags;

/** User-facing profile tags (ownership markers stripped). */
export const userProfileTags = (
  tags: Record<string, string | undefined> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith(MARKER_PREFIX),
    ),
  );
