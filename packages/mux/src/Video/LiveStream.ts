import * as MuxRetry from "@distilled.cloud/mux/Retry";
import * as Video from "@distilled.cloud/mux/video";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { matches, metaWrite } from "../internal/converge.ts";
import {
  playbackIdsByPolicy,
  type PlaybackIdsByPolicy,
  sortPlaybackIds,
} from "../internal/playback.ts";
import { redact } from "../internal/redact.ts";
import type { Providers } from "../Providers.ts";

export type LatencyMode = "low" | "reduced" | "standard";

export interface LiveStreamProps {
  /**
   * Playback policies for the stream's playback IDs: `public`, `signed`
   * (needs a token from `Mux.Video.PlaybackSigner`) or `drm`. Changing it
   * replaces the stream.
   */
  playback_policies?: Video.PlaybackPolicy[];
  /**
   * Playback IDs with per-ID settings, such as a DRM configuration. Changing
   * it replaces the stream.
   */
  advanced_playback_policies?: Video.CreatePlaybackIDRequest[];
  /**
   * Settings for the asset Mux records from each broadcast. `mp4_support`,
   * `master_access`, `video_quality` (`plus` or `premium`) and `meta` update
   * in place; changing any other field replaces the stream.
   */
  new_asset_settings?: Video.AssetOptions;
  /**
   * Seconds Mux waits for an encoder to reconnect before ending the
   * broadcast, from 0 to 1800.
   * @default 60 for `standard` latency, 0 for `reduced` and `low`
   */
  reconnect_window?: number;
  /**
   * Show a slate while the encoder is disconnected on a `standard` latency
   * stream.
   * @default false
   */
  use_slate_for_standard_latency?: boolean;
  /**
   * Image shown as the reconnect slate. Mux uses its own slate when empty.
   */
  reconnect_slate_url?: string;
  /**
   * Your own identifier for the stream, up to 255 characters.
   */
  passthrough?: string;
  /**
   * Ingest audio only. Changing it replaces the stream.
   * @default false
   */
  audio_only?: boolean;
  /**
   * CEA-608 captions carried in the encoder's video, one entry per channel.
   * Mux rejects them on a `low` latency stream.
   */
  embedded_subtitles?: Video.LiveStreamEmbeddedSubtitleRequest[];
  /**
   * Captions Mux generates from the stream's audio. Reference a
   * `Mux.Video.TranscriptionVocabulary` in `transcription_vocabulary_ids` to
   * improve recognition of names and jargon. Mux rejects them on a `low`
   * latency stream.
   */
  generated_subtitles?: Video.LiveStreamGeneratedSubtitleRequest[];
  /**
   * Glass-to-glass latency: `standard` (about 25 seconds), `reduced` (12 to
   * 20 seconds) or `low` (5 to 10 seconds).
   * @default "standard"
   */
  latency_mode?: LatencyMode;
  /**
   * Test streams are free, watermarked, limited to 5 minutes per broadcast
   * and deleted after 24 hours. Mux rejects simulcast targets on them.
   * Changing it replaces the stream.
   * @default false
   */
  test?: boolean;
  /**
   * Longest single broadcast in seconds, from 60 to 43200. Test streams are
   * fixed at 300.
   * @default 43200
   */
  max_continuous_duration?: number;
  /**
   * Metadata Mux keeps with the stream. Only `title` is stored.
   */
  meta?: Video.LiveStreamMetadata;
  /**
   * `false` disables the stream so encoders cannot connect.
   * @default true
   */
  enabled?: boolean;
}

export interface LiveStreamAttributes extends PlaybackIdsByPolicy {
  /** Mux live stream ID. */
  id: string;
  /** Unix time, in seconds, the stream was created. */
  created_at: string;
  /** `idle`, `active` while an encoder is connected, or `disabled`. */
  status: Video.LiveStreamStatus;
  /** Secret. Anyone holding it can broadcast to this stream. */
  stream_key: Redacted.Redacted<string>;
  /** Secret that encrypts an SRT broadcast. */
  srt_passphrase: Redacted.Redacted<string>;
  /** RTMPS ingest endpoint; pair it with `stream_key`. */
  rtmps_url: string;
  /** SRT ingest endpoint; use `stream_key` as the stream ID and `srt_passphrase`. */
  srt_url: string;
  /** The stream's playback IDs, sorted by policy and ID. */
  playback_ids: Video.PlaybackID[];
  /** Latency mode Mux applies. */
  latency_mode: Video.LiveStreamLatencyMode;
  /** Reconnect window in seconds. Mux omits it when it is 0. */
  reconnect_window?: number;
  /** Whether the reconnect slate is on for `standard` latency. Omitted when `false`. */
  use_slate_for_standard_latency?: boolean;
  /** Reconnect slate image. Omitted when unset. */
  reconnect_slate_url?: string;
  /** Longest single broadcast in seconds. */
  max_continuous_duration: number;
  /** Your identifier for the stream. Omitted when empty. */
  passthrough?: string;
  /** Stream metadata. */
  meta?: Video.LiveStreamMetadata;
  /** Settings for recorded assets. */
  new_asset_settings?: Video.AssetOptions;
  /** Embedded caption channels. */
  embedded_subtitles?: Video.LiveStreamEmbeddedSubtitleSettings[];
  /** Generated caption tracks. */
  generated_subtitles?: Video.LiveStreamGeneratedSubtitleSettings[];
  /** Whether the stream ingests audio only. */
  audio_only?: boolean;
  /** Whether this is a test stream. */
  test?: boolean;
  /** Asset recording the current broadcast, while the stream is `active`. */
  active_asset_id?: string;
  /** Assets recorded from recent broadcasts. */
  recent_asset_ids?: string[];
}

export type LiveStream = Resource<
  "Mux.Video.LiveStream",
  LiveStreamProps,
  LiveStreamAttributes,
  never,
  Providers
>;

/**
 * A Mux live stream: a persistent ingest endpoint and stream key. Each
 * broadcast is recorded as a Mux asset.
 * @see https://www.mux.com/docs/guides/start-live-streaming
 *
 * Updates compare the props with the stream as Mux reports it, so a deploy
 * after a failed one finishes or reverts the half-applied change, and drift
 * repair puts back settings changed outside Alchemy. A setting removed from
 * the props returns to Mux's default.
 *
 * :::caution
 * Changing `playback_policies`, `advanced_playback_policies`, `audio_only`,
 * `test`, or any `new_asset_settings` field other than `mp4_support`,
 * `master_access`, `video_quality` and `meta` replaces the stream. The new
 * stream has a new stream key and new playback IDs, so encoders and players
 * must be updated.
 * :::
 *
 * :::caution
 * Mux does not allow `latency_mode: "low"` together with
 * `generated_subtitles` or `embedded_subtitles`. When both change in one
 * deploy, captions are removed before the latency changes.
 * :::
 *
 * ### Creating a LiveStream
 * **Example:** Public stream with the default settings
 * ```typescript
 * const stream = yield* Mux.Video.LiveStream("MainStage", {
 *   playback_policies: ["public"],
 * });
 * ```
 *
 * **Example:** Signed playback and premium recordings
 * ```typescript
 * const stream = yield* Mux.Video.LiveStream("MainStage", {
 *   playback_policies: ["signed"],
 *   new_asset_settings: {
 *     playback_policies: ["signed"],
 *     video_quality: "premium",
 *   },
 * });
 * ```
 *
 * ### Latency and reconnects
 * **Example:** Low latency with a short reconnect window
 * ```typescript
 * const stream = yield* Mux.Video.LiveStream("MainStage", {
 *   playback_policies: ["public"],
 *   latency_mode: "low",
 *   reconnect_window: 15,
 * });
 * ```
 *
 * **Example:** Standard latency with a reconnect slate
 * ```typescript
 * const stream = yield* Mux.Video.LiveStream("MainStage", {
 *   playback_policies: ["public"],
 *   reconnect_window: 120,
 *   use_slate_for_standard_latency: true,
 *   reconnect_slate_url: "https://example.com/be-right-back.png",
 * });
 * ```
 *
 * ### Captions
 * **Example:** Reduced latency with live English captions
 * ```typescript
 * const vocab = yield* Mux.Video.TranscriptionVocabulary("Speakers", {
 *   phrases: ["Mux", "Alchemy"],
 * });
 * const stream = yield* Mux.Video.LiveStream("MainStage", {
 *   playback_policies: ["public"],
 *   latency_mode: "reduced",
 *   generated_subtitles: [
 *     { language_code: "en", transcription_vocabulary_ids: [vocab.id] },
 *   ],
 * });
 * ```
 *
 * **Example:** Pass through captions from the encoder
 * ```typescript
 * const stream = yield* Mux.Video.LiveStream("MainStage", {
 *   playback_policies: ["public"],
 *   embedded_subtitles: [{ language_code: "en", language_channel: "cc1" }],
 * });
 * ```
 *
 * ### Pausing a stream
 * **Example:** Disable ingest without deleting the stream
 * ```typescript
 * const stream = yield* Mux.Video.LiveStream("MainStage", {
 *   playback_policies: ["public"],
 *   enabled: false,
 * });
 * ```
 *
 * ### Broadcasting
 * Point an encoder at `rtmps_url` with `stream_key`, or at `srt_url` with
 * `stream_key` as the stream ID and `srt_passphrase`. Both secrets are kept
 * as `Redacted` values in Alchemy state. Play the stream at
 * `https://stream.mux.com/{public_playback_id}.m3u8`.
 *
 * **Example:** Restream to another platform
 * ```typescript
 * const stream = yield* Mux.Video.LiveStream("MainStage", {
 *   playback_policies: ["public"],
 * });
 * yield* Mux.Video.SimulcastTarget("YouTube", {
 *   live_stream_id: stream.id,
 *   url: "rtmps://a.rtmp.youtube.com/live2",
 *   stream_key: Redacted.make(process.env.YOUTUBE_STREAM_KEY!),
 * });
 * ```
 *
 * @resource
 */
export const LiveStream = Resource<LiveStream>("Mux.Video.LiveStream");

/** Raised if the engine asks to update a field Mux only sets at creation. */
export class LiveStreamImmutableChange extends Data.TaggedError("LiveStreamImmutableChange")<{
  readonly id: string;
}> {
  override get message() {
    return `Live stream ${this.id} has a change to a field Mux only sets at creation; it must be replaced.`;
  }
}

/** Props Mux can change on an existing stream. Changing any other prop replaces it. */
const UPDATABLE: ReadonlySet<string> = new Set([
  "passthrough",
  "latency_mode",
  "reconnect_window",
  "use_slate_for_standard_latency",
  "reconnect_slate_url",
  "max_continuous_duration",
  "meta",
  "new_asset_settings",
  "generated_subtitles",
  "embedded_subtitles",
  "enabled",
] satisfies (keyof LiveStreamProps)[]);

const NEW_ASSET_UPDATABLE = ["mp4_support", "master_access", "video_quality", "meta"];

const omit = (value: object | undefined, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key)));

const propsChanged = (olds: LiveStreamProps, news: LiveStreamProps) =>
  [...new Set([...Object.keys(olds), ...Object.keys(news)])].filter((key) => {
    const field = key as keyof LiveStreamProps;
    return !isResolved(news[field]) || !deepEqual(olds[field], news[field]);
  });

const replaces = (olds: LiveStreamProps, news: LiveStreamProps) =>
  propsChanged(olds, news).some(
    (key) =>
      !UPDATABLE.has(key) ||
      (key === "new_asset_settings" &&
        !deepEqual(
          omit(olds.new_asset_settings, NEW_ASSET_UPDATABLE),
          omit(news.new_asset_settings, NEW_ASSET_UPDATABLE),
        )),
  );

type Patch = Omit<Video.UpdateLiveStreamRequest, "LIVE_STREAM_ID">;

const PATCHED = [
  "passthrough",
  "latency_mode",
  "reconnect_window",
  "use_slate_for_standard_latency",
  "reconnect_slate_url",
  "max_continuous_duration",
] as const satisfies readonly (keyof Patch & keyof LiveStreamProps & keyof Video.LiveStream)[];

/** What a new stream with these props holds for each PATCH field the props leave out. */
const createDefaults = (news: LiveStreamProps) => ({
  passthrough: "",
  latency_mode: "standard",
  // 60 for standard latency, 0 for reduced and low.
  reconnect_window: (news.latency_mode ?? "standard") === "standard" ? 60 : 0,
  use_slate_for_standard_latency: false,
  reconnect_slate_url: "",
  // Test streams are fixed at 300 seconds, so nothing is written.
  max_continuous_duration: news.test ? undefined : 43200,
});

/** Mux omits these fields from responses when they are empty, false or 0. */
const OMITTED_WHEN_EMPTY: Partial<Record<(typeof PATCHED)[number], unknown>> = {
  passthrough: "",
  use_slate_for_standard_latency: false,
  reconnect_slate_url: "",
  reconnect_window: 0,
};

/** Fields Mux omits when empty are filled in on both sides, so clearing them is visible. */
const caption = <T extends { passthrough?: string; transcription_vocabulary_ids?: string[] }>(
  c: T,
  generated: boolean,
) => ({
  ...c,
  passthrough: c.passthrough ?? "",
  ...(generated && { transcription_vocabulary_ids: c.transcription_vocabulary_ids ?? [] }),
});

const captionsMatch = <
  T extends { passthrough?: string; transcription_vocabulary_ids?: string[] },
  U extends { passthrough?: string; transcription_vocabulary_ids?: string[] },
>(
  want: readonly T[],
  have: readonly U[] | undefined,
  generated: boolean,
) =>
  matches(
    want.map((c) => caption(c, generated)),
    (have ?? []).map((c) => caption(c, generated)),
  );

/** The writes that bring a stream to the state the props describe. */
interface Pending {
  patch: Patch;
  generated_subtitles?: Video.LiveStreamGeneratedSubtitleRequest[];
  embedded_subtitles?: Video.LiveStreamEmbeddedSubtitleRequest[];
  enabled?: boolean;
}

const pending = (news: LiveStreamProps, live: Video.LiveStream): Pending => {
  const defaults = createDefaults(news);
  const patch: Patch = {};
  for (const key of PATCHED) {
    const want = news[key] ?? defaults[key];
    const have = live[key] ?? OMITTED_WHEN_EMPTY[key];
    if (want !== undefined && want !== have) Object.assign(patch, { [key]: want });
  }
  const meta = metaWrite({ ...news.meta }, { ...live.meta });
  if (meta) patch.meta = meta;

  const wantAsset = news.new_asset_settings ?? {};
  const haveAsset = live.new_asset_settings ?? {};
  const asset: Video.UpdateLiveStreamNewAssetSettings = {};
  if ((wantAsset.mp4_support ?? "none") !== (haveAsset.mp4_support ?? "none")) {
    asset.mp4_support = wantAsset.mp4_support ?? "none";
  }
  if ((wantAsset.master_access ?? "none") !== (haveAsset.master_access ?? "none")) {
    asset.master_access = wantAsset.master_access ?? "none";
  }
  if (
    wantAsset.video_quality !== undefined &&
    wantAsset.video_quality !== haveAsset.video_quality
  ) {
    asset.video_quality = wantAsset.video_quality;
  }
  const assetMeta = metaWrite({ ...wantAsset.meta }, { ...haveAsset.meta });
  if (assetMeta) asset.meta = assetMeta;
  if (Object.keys(asset).length > 0) patch.new_asset_settings = asset;

  const generated = news.generated_subtitles ?? [];
  const embedded = news.embedded_subtitles ?? [];
  return {
    patch,
    ...(!captionsMatch(generated, live.generated_subtitles, true) && {
      generated_subtitles: generated,
    }),
    ...(!captionsMatch(embedded, live.embedded_subtitles, false) && {
      embedded_subtitles: embedded,
    }),
    ...((news.enabled === false) !== (live.status === "disabled") && {
      enabled: news.enabled !== false,
    }),
  };
};

const RTMPS_URL = "rtmps://global-live.mux.com:443/app";
const SRT_URL = "srt://global-live.mux.com:6001";

const toAttrs = (stream: Video.LiveStream): LiveStreamAttributes => ({
  id: stream.id,
  created_at: stream.created_at,
  status: stream.status,
  stream_key: redact(stream.stream_key),
  srt_passphrase: redact(stream.srt_passphrase),
  rtmps_url: RTMPS_URL,
  srt_url: SRT_URL,
  playback_ids: sortPlaybackIds(stream.playback_ids),
  ...playbackIdsByPolicy(stream.playback_ids ?? []),
  latency_mode: stream.latency_mode,
  reconnect_window: stream.reconnect_window,
  use_slate_for_standard_latency: stream.use_slate_for_standard_latency,
  reconnect_slate_url: stream.reconnect_slate_url,
  max_continuous_duration: stream.max_continuous_duration,
  passthrough: stream.passthrough,
  meta: stream.meta,
  new_asset_settings: stream.new_asset_settings,
  embedded_subtitles: stream.embedded_subtitles,
  generated_subtitles: stream.generated_subtitles,
  audio_only: stream.audio_only,
  test: stream.test,
  active_asset_id: stream.active_asset_id,
  recent_asset_ids: stream.recent_asset_ids,
});

export const LiveStreamProvider = () =>
  Provider.effect(
    LiveStream,
    Effect.gen(function* () {
      const create = yield* Video.createLiveStream;
      const get = yield* Video.getLiveStream;
      const update = yield* Video.updateLiveStream;
      const putGenerated = yield* Video.updateLiveStreamGeneratedSubtitles;
      const putEmbedded = yield* Video.updateLiveStreamEmbeddedSubtitles;
      const enable = yield* Video.enableLiveStream;
      const disable = yield* Video.disableLiveStream;
      const del = yield* Video.deleteLiveStream;
      const list = yield* Video.listLiveStreams;

      const observe = (id: string | undefined) =>
        id === undefined
          ? Effect.undefined
          : get({ LIVE_STREAM_ID: id }).pipe(
              Effect.map((res) => res.data),
              Effect.catchTag("NotFound", () => Effect.undefined),
            );

      // A create that failed with a 5xx may still have happened, so it is
      // retried only on throttling. `enabled` is applied afterwards by `write`.
      const createStream = ({ enabled: _enabled, ...body }: LiveStreamProps) =>
        create(body).pipe(
          MuxRetry.throttling,
          Effect.map((res) => res.data),
        );

      const write = Effect.fn(function* (LIVE_STREAM_ID: string, p: Pending) {
        const generated = p.generated_subtitles;
        const embedded = p.embedded_subtitles;
        // Mux rejects low latency while captions are on, so captions are
        // removed before the PATCH and added after it.
        if (generated?.length === 0)
          yield* putGenerated({ LIVE_STREAM_ID, generated_subtitles: [] });
        if (embedded?.length === 0) yield* putEmbedded({ LIVE_STREAM_ID, embedded_subtitles: [] });
        if (Object.keys(p.patch).length > 0) yield* update({ LIVE_STREAM_ID, ...p.patch });
        if (generated?.length)
          yield* putGenerated({ LIVE_STREAM_ID, generated_subtitles: generated });
        if (embedded?.length) yield* putEmbedded({ LIVE_STREAM_ID, embedded_subtitles: embedded });
        if (p.enabled === true) yield* enable({ LIVE_STREAM_ID });
        if (p.enabled === false) yield* disable({ LIVE_STREAM_ID });
      });

      const isNoop = (p: Pending) =>
        Object.keys(p.patch).length === 0 &&
        p.generated_subtitles === undefined &&
        p.embedded_subtitles === undefined &&
        p.enabled === undefined;

      return {
        stables: ["id", "stream_key", "srt_passphrase", "rtmps_url", "srt_url"],
        list: () =>
          list.items({ limit: 100 }).pipe(
            Stream.runCollect,
            Effect.map((streams) => streams.map(toAttrs)),
          ),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (output === undefined) return undefined;
          const props = news as LiveStreamProps;
          if (replaces(olds ?? {}, props)) return { action: "replace" } as const;
          return propsChanged(olds ?? {}, props).length > 0
            ? ({ action: "update" } as const)
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, olds, output }) {
          const observed = yield* observe(output?.id);
          if (observed !== undefined && olds !== undefined && replaces(olds, news)) {
            return yield* new LiveStreamImmutableChange({ id: observed.id });
          }
          const stream = observed ?? (yield* createStream(news));

          const writes = pending(news, stream);
          if (isNoop(writes)) return toAttrs(stream);
          yield* write(stream.id, writes);
          // PATCH and PUT responses omit fields such as playback_ids, so re-read.
          const { data: synced } = yield* get({ LIVE_STREAM_ID: stream.id });
          return toAttrs(synced);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ LIVE_STREAM_ID: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          const observed = yield* observe(output?.id);
          return observed === undefined ? undefined : toAttrs(observed);
        }),
      };
    }),
  );
