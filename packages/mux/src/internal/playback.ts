/** Mux returns playback IDs in no stable order; sort so attributes are deterministic. */
export const sortPlaybackIds = <P extends { id?: string; policy?: string }>(
  ids: ReadonlyArray<P> | undefined,
): P[] =>
  [...(ids ?? [])].sort((a, b) => `${a.policy}:${a.id}`.localeCompare(`${b.policy}:${b.id}`));

/**
 * First playback ID per policy. Alchemy Outputs cannot be indexed, so these
 * give stacks a direct handle: `asset.public_playback_id`.
 */
export const playbackIdsByPolicy = (
  ids: ReadonlyArray<{ id?: string; policy?: string }>,
): PlaybackIdsByPolicy => ({
  public_playback_id: ids.find((p) => p.policy === "public")?.id,
  signed_playback_id: ids.find((p) => p.policy === "signed")?.id,
  drm_playback_id: ids.find((p) => p.policy === "drm")?.id,
});

export interface PlaybackIdsByPolicy {
  /** First `public` playback ID: `https://stream.mux.com/{id}.m3u8`. */
  public_playback_id?: string;
  /** First `signed` playback ID; play it with a token from `PlaybackSigner`. */
  signed_playback_id?: string;
  /** First `drm` playback ID. */
  drm_playback_id?: string;
}
