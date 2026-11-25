/**
 * True when every value `desired` sets is present in `actual`. Arrays must
 * have the same length and match element by element. Keys `desired` leaves
 * undefined are not compared, so defaults Mux fills in do not count as drift.
 */
export const matches = (desired: unknown, actual: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(actual) &&
      actual.length === desired.length &&
      desired.every((d, i) => matches(d, actual[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (actual === null || typeof actual !== "object") return false;
    return Object.entries(desired).every(([key, value]) =>
      matches(value, (actual as Record<string, unknown>)[key]),
    );
  }
  return desired === actual;
};

/**
 * The `meta` object to send so Mux ends up holding exactly `want`, or
 * undefined if it already does. Mux ignores `{}`; a key is cleared by
 * sending it as an empty string.
 */
export const metaWrite = (
  want: Record<string, string | undefined> | undefined,
  have: Record<string, string | undefined> | undefined,
) => {
  const keys = [...new Set([...Object.keys(want ?? {}), ...Object.keys(have ?? {})])];
  const body = Object.fromEntries(keys.map((key) => [key, want?.[key] ?? ""]));
  return keys.some((key) => body[key] !== (have?.[key] ?? "")) ? body : undefined;
};

interface PlaybackIdLike {
  readonly id?: string;
  readonly policy?: string;
  readonly drm_configuration_id?: string;
}

const playbackSignature = (p: PlaybackIdLike) => `${p.policy}:${p.drm_configuration_id ?? ""}`;

/**
 * Pairs wanted playback IDs with live ones by policy and DRM configuration,
 * one live ID per wanted entry. Wanted entries left unpaired are created;
 * live IDs left unpaired are deleted.
 */
export const playbackIdChanges = <W extends PlaybackIdLike, L extends PlaybackIdLike>(
  wanted: ReadonlyArray<W>,
  live: ReadonlyArray<L>,
) => {
  const unclaimed = [...live];
  const create: W[] = [];
  for (const want of wanted) {
    const i = unclaimed.findIndex((p) => playbackSignature(p) === playbackSignature(want));
    if (i === -1) create.push(want);
    else unclaimed.splice(i, 1);
  }
  return { create, remove: unclaimed };
};
