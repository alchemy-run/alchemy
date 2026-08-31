import * as Context from "effect/Context";

export class Stage extends Context.Service<Stage, string>()("Stage") {}

/**
 * User-chosen stages (`--stage`, `$STAGE`, the `dev_$USER` deploy default).
 * Colon is reserved for {@link LOCAL_DEV_STAGE_PREFIX} so `alchemy dev`
 * can never share a state row with `alchemy deploy`.
 */
export const USER_STAGE_PATTERN = /^[a-z0-9]+([-_a-z0-9]+)*$/i;

/** Engine-owned local-dev stage prefix. Users cannot pass this via `--stage`. */
export const LOCAL_DEV_STAGE_PREFIX = "local:";

export const isUserStage = (stage: string): boolean =>
  USER_STAGE_PATTERN.test(stage);

export const isLocalDevStage = (stage: string): boolean =>
  stage.startsWith(LOCAL_DEV_STAGE_PREFIX);

/**
 * `$USER` / `$USERNAME` can contain dots, spaces, or domain prefixes that
 * are illegal in user stages. Fold those down so `local:<user>` is a
 * stable path-safe token.
 */
export const sanitizeLocalDevUser = (user: string): string => {
  const cleaned = user
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "unknown";
};

/** State key `alchemy dev` (and `alchemy destroy --dev`) always uses. */
export const localDevStage = (user: string): string =>
  `${LOCAL_DEV_STAGE_PREFIX}${sanitizeLocalDevUser(user)}`;

/**
 * Encode a stage name as a single filesystem path segment.
 *
 * `local:sam` is not a legal directory name on Windows (`:`). Percent-encoding
 * leaves existing user stages (`dev_sam`, `prod`) unchanged — they contain
 * only unreserved URI characters — so this is a no-op for pre-existing
 * on-disk state.
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
