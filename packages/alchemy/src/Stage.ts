import * as Context from "effect/Context";

export class Stage extends Context.Service<Stage, string>()("Stage") {}

/**
 * User-chosen stages (`--stage`, `$STAGE`, and the per-command defaults
 * `live_$USER` / `dev_$USER`). Must match `[a-z0-9]+([-_a-z0-9]+)*`.
 */
export const USER_STAGE_PATTERN = /^[a-z0-9]+([-_a-z0-9]+)*$/i;

export const isUserStage = (stage: string): boolean =>
  USER_STAGE_PATTERN.test(stage);

/**
 * Encode a stage name as a single filesystem path segment.
 *
 * Percent-encoding leaves typical stages (`live_sam`, `prod`) unchanged —
 * they contain only unreserved URI characters — so this is a no-op for
 * existing on-disk state. Stages with `:` or other reserved characters
 * (illegal as `--stage`, but possible in leftover rows) become Windows-safe.
 */
export const encodeStagePathSegment = (stage: string): string =>
  encodeURIComponent(stage);

export const decodeStagePathSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};
