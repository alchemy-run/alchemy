import * as MuxRetry from "@distilled.cloud/mux/Retry";
import * as Robots from "@distilled.cloud/mux/robots";
import * as Video from "@distilled.cloud/mux/video";
import { deepEqual, isResolved } from "alchemy/Diff";
import type { Input } from "alchemy/Input";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { metaWrite, playbackIdChanges } from "../internal/converge.ts";
import {
  playbackIdsByPolicy,
  type PlaybackIdsByPolicy,
  sortPlaybackIds,
} from "../internal/playback.ts";
import type { Providers } from "../Providers.ts";

export interface AssetProps {
  /**
   * The files the asset is made from. The first input is the video. Further
   * inputs are `text` tracks (subtitles, captions, chapters), `audio` tracks
   * (alternate languages), or a watermark image (`overlay_settings`).
   *
   * Text and audio inputs, and the first input's `generated_subtitles`, are
   * added to and removed from the existing asset. Changing the video input
   * or a watermark replaces the asset, which ingests and encodes it again.
   */
  inputs: Video.InputSettings[];
  /**
   * Playback policies, one playback ID each: `public` plays from
   * `https://stream.mux.com/{id}.m3u8`, `signed` needs a token from
   * `Mux.Video.PlaybackSigner`. Playback IDs are added and removed in place.
   * When neither this nor `advanced_playback_policies` is set, Alchemy leaves
   * the asset's playback IDs alone.
   */
  playback_policies?: Video.PlaybackPolicy[];
  /**
   * Playback policies with extra settings, such as a DRM configuration.
   * Changing it replaces the asset.
   */
  advanced_playback_policies?: Video.CreatePlaybackIDRequest[];
  /**
   * Free-form string echoed in the asset and its webhooks. Max 255
   * characters. Updated in place.
   * @default ""
   */
  passthrough?: string;
  /**
   * Title, creator ID and external ID. Updated in place, and a key removed
   * here is cleared in Mux. May be visible to viewers through the player.
   */
  meta?: Video.AssetMetadata;
  /**
   * Seconds into the video for the default thumbnail. Updated in place;
   * removing it returns the thumbnail to Mux's default.
   */
  thumbnail_time?: number;
  /**
   * `temporary` makes a downloadable master MP4 available for 24 hours.
   * Updated in place.
   * @default "none"
   */
  master_access?: Video.CreateAssetRequestMasterAccess;
  /**
   * Static MP4 or M4A renditions, matched by `resolution`. Renditions are
   * added and removed in place.
   */
  static_renditions?: Video.CreateStaticRenditionRequest[];
  /**
   * Mux Robots directives to run on the asset. A directive added here runs
   * once on the existing asset; runs are never repeated.
   */
  directives?: Video.AssetDirective[];
  /**
   * Create a free test asset: watermarked, limited to 10 seconds, and
   * deleted by Mux after 24 hours. Changing it replaces the asset.
   * @default false
   */
  test?: boolean;
  /**
   * Encoding quality and cost tier. Changing it replaces the asset.
   * @default the environment's default video quality
   */
  video_quality?: Video.CreateAssetRequestVideoQuality;
  /**
   * Highest resolution the asset is encoded, stored and streamed at.
   * Changing it replaces the asset.
   * @default "1080p"
   */
  max_resolution_tier?: Video.CreateAssetRequestMaxResolutionTier;
  /**
   * Normalize the audio loudness. Changing it replaces the asset.
   * @default false
   */
  normalize_audio?: boolean;
  /**
   * Detect shot boundaries in the video. Changing it replaces the asset.
   * @default false
   */
  generate_shots?: boolean;
  /**
   * For a clip (`mux://assets/{id}` input), copy the source asset's
   * overlays. Changing it replaces the asset.
   */
  copy_overlays?: boolean;
  /**
   * Wait during deploy until Mux finishes ingesting the asset and its tracks.
   * When ingest errors, the deploy fails and the errored asset is deleted.
   * @default true
   */
  wait_for_ready?: boolean;
}

export interface AssetAttributes extends PlaybackIdsByPolicy {
  /** Mux asset ID. */
  id: string;
  /** Creation time, in seconds since the Unix epoch. */
  created_at: string;
  /** `preparing`, `ready` or `errored`. */
  status: Video.AssetStatus;
  /** Length in seconds. */
  duration: number | undefined;
  /** Aspect ratio as `width:height`, for example `16:9`. */
  aspect_ratio: string | undefined;
  /** Resolution tier the asset was ingested at. */
  resolution_tier: Video.AssetResolutionTier | undefined;
  /** Highest resolution tier the asset is encoded at. */
  max_resolution_tier: Video.AssetMaxResolutionTier;
  /** Encoding quality tier. */
  video_quality: Video.AssetVideoQuality | undefined;
  /** Whether this is a test asset. */
  test: boolean | undefined;
  /** Free-form string echoed in webhooks. */
  passthrough: string | undefined;
  /** Title, creator ID and external ID. */
  meta: Video.AssetMetadata | undefined;
  /** `none` or `temporary`. */
  master_access: Video.AssetMasterAccess;
  /** Status of the downloadable master MP4 while master access is on. */
  master: Video.AssetMaster | undefined;
  /** Seconds into the video for the default thumbnail. */
  thumbnail_time: number | undefined;
  /** Playback IDs, sorted by policy and ID. */
  playback_ids: Video.PlaybackID[];
  /** Static renditions and their status. */
  static_renditions: Video.AssetStaticRenditions | undefined;
  /** Video, audio and text tracks. */
  tracks: Video.Track[];
  /** Mux Robots directives attached when the asset was created. */
  directives: Video.AssetDirective[] | undefined;
  /** Why ingest failed, when `status` is `errored`. */
  errors: Video.AssetErrors | undefined;
}

export type Asset = Resource<"Mux.Video.Asset", AssetProps, AssetAttributes, never, Providers>;

/**
 * A Mux Video asset ingested from a URL: hero and marketing videos, demo
 * content, seed data for preview environments. Needs a token with Video
 * write, and Robots write for `directives`.
 *
 * These props update in place: `passthrough`, `meta`, `thumbnail_time`,
 * `master_access`, `static_renditions`, `playback_policies`, `directives`
 * (newly listed directives run on the existing asset), and text and audio
 * tracks: every `text` and `audio` input, plus the first input's
 * `generated_subtitles`.
 *
 * Updates compare the props with the asset as Mux reports it, so a deploy
 * after a failed one finishes or reverts the half-applied change, and drift
 * repair puts back settings changed outside Alchemy, including declared
 * tracks deleted outside it. A setting removed from the props returns to
 * Mux's default.
 *
 * A removed track is found by its type, language and name, because Mux does
 * not report a track's source URL. Give tracks that share a type and
 * language distinct names; Mux also requires names to be unique per asset.
 * A changed track is removed before its replacement is added. If a new track
 * errors, the deploy fails with `AssetTrackFailed` and the asset's tracks are
 * put back as they were.
 *
 * :::caution
 * Changing the video input, adding or changing a watermark input, or
 * changing `test`, `video_quality`, `max_resolution_tier`,
 * `normalize_audio`, `generate_shots`, `copy_overlays` or
 * `advanced_playback_policies` replaces the asset: Mux ingests and encodes
 * the video again, and the new asset has new playback IDs.
 * :::
 * @see https://www.mux.com/docs/core/stream-video-files
 *
 * ### Creating an Asset
 * **Example:** A public video
 * ```typescript
 * const intro = yield* Mux.Video.Asset("Intro", {
 *   inputs: [{ url: "https://muxed.s3.amazonaws.com/leds.mp4" }],
 *   playback_policies: ["public"],
 *   meta: { title: "Intro" },
 * });
 * // https://stream.mux.com/${intro.public_playback_id}.m3u8
 * ```
 *
 * **Example:** A free test asset for a preview environment
 * ```typescript
 * const demo = yield* Mux.Video.Asset("Demo", {
 *   inputs: [{ url: "https://muxed.s3.amazonaws.com/leds.mp4" }],
 *   playback_policies: ["public"],
 *   test: true,
 * });
 * ```
 *
 * ### Captions and audio tracks
 * **Example:** AI captions, French subtitles and a Spanish audio track
 * ```typescript
 * const hero = yield* Mux.Video.Asset("Hero", {
 *   inputs: [
 *     {
 *       url: "https://example.com/hero.mp4",
 *       generated_subtitles: [{ language_code: "en", name: "English (generated)" }],
 *     },
 *     {
 *       url: "https://example.com/hero-fr.vtt",
 *       type: "text",
 *       text_type: "subtitles",
 *       language_code: "fr",
 *       name: "Français",
 *     },
 *     { url: "https://example.com/hero-es.m4a", type: "audio", language_code: "es", name: "Español" },
 *   ],
 *   playback_policies: ["public"],
 * });
 * ```
 *
 * ### Downloads and thumbnails
 * **Example:** An MP4 download and a thumbnail two seconds in
 * ```typescript
 * const hero = yield* Mux.Video.Asset("Hero", {
 *   inputs: [{ url: "https://example.com/hero.mp4" }],
 *   playback_policies: ["public", "signed"],
 *   static_renditions: [{ resolution: "highest" }],
 *   thumbnail_time: 2,
 * });
 * ```
 *
 * ### Watermarks
 * **Example:** A logo in the top right corner
 * ```typescript
 * const branded = yield* Mux.Video.Asset("Branded", {
 *   inputs: [
 *     { url: "https://example.com/hero.mp4" },
 *     {
 *       url: "https://example.com/logo.png",
 *       overlay_settings: { horizontal_align: "right", width: "10%" },
 *     },
 *   ],
 *   playback_policies: ["public"],
 * });
 * ```
 *
 * ### Running Robots directives
 * **Example:** Moderate the asset with a directive
 * ```typescript
 * const moderation = yield* Mux.Robots.Directive("Moderation", {
 *   name: "moderation",
 *   bindings: [{ reference_id: "moderation", workflow: "moderate" }],
 * });
 * const upload = yield* Mux.Video.Asset("Upload", {
 *   inputs: [{ url: "https://example.com/upload.mp4" }],
 *   directives: [{ id: moderation.id }],
 * });
 * ```
 *
 * @resource
 */
export const Asset = Resource<Asset>("Mux.Video.Asset");

/** Mux could not ingest the input. The errored asset has been deleted. */
export class AssetIngestFailed extends Data.TaggedError("AssetIngestFailed")<{
  readonly id: string;
  readonly reason: string;
}> {
  override get message() {
    return `Mux could not ingest asset ${this.id}: ${this.reason}`;
  }
}

/** A track added to an existing asset errored. The tracks added in that deploy were removed. */
export class AssetTrackFailed extends Data.TaggedError("AssetTrackFailed")<{
  readonly id: string;
  readonly track: string;
}> {
  override get message() {
    return `Mux could not add the ${this.track} to asset ${this.id}. The tracks added in this deploy were removed.`;
  }
}

/** Several tracks match a removed input, so the provider cannot tell which to delete. */
export class AssetTrackAmbiguous extends Data.TaggedError("AssetTrackAmbiguous")<{
  readonly id: string;
  readonly track: string;
}> {
  override get message() {
    return `Asset ${this.id} has several tracks matching the removed ${this.track}. Give tracks that share a type and language distinct names.`;
  }
}

/** Raised if the engine asks to update a field Mux only sets at creation. */
export class AssetImmutableChange extends Data.TaggedError("AssetImmutableChange")<{
  readonly id: string;
}> {
  override get message() {
    return `Asset ${this.id} has a change to a field Mux only sets at creation; it must be replaced.`;
  }
}

type Input_ = Video.InputSettings;
type TrackInput = Input_ & { url: string; type: "text" | "audio"; language_code: string };
type GeneratedSubtitles = Video.AssetGeneratedSubtitleSettings;

/** Props Mux can change on an existing asset. */
const UPDATABLE: ReadonlySet<keyof AssetProps> = new Set<keyof AssetProps>([
  "passthrough",
  "meta",
  "thumbnail_time",
  "master_access",
  "static_renditions",
  "playback_policies",
  "directives",
  "inputs",
  "wait_for_ready",
]);

const isTrack = (input: Input_): input is TrackInput =>
  (input.type === "text" || input.type === "audio") &&
  input.url !== undefined &&
  input.language_code !== undefined;

/**
 * The video and any watermark (overlay) inputs are the source, which only a
 * new asset can change. Text and audio inputs, and the video's generated
 * subtitles, are tracks.
 */
const splitInputs = (inputs: Input_[] | undefined) => {
  const [first, ...rest] = inputs ?? [];
  const { generated_subtitles, ...video } = first ?? {};
  return {
    source: [video, ...rest.filter((input) => !isTrack(input))],
    subtitles: generated_subtitles ?? [],
    tracks: rest.filter(isTrack),
  };
};

const sameSource = (olds: Input_[] | undefined, news: Input<Input_[] | undefined>) =>
  isResolved(news) && deepEqual(splitInputs(olds).source, splitInputs(news).source);

const plan = (olds: AssetProps, news: Input<AssetProps>): "replace" | "update" | undefined => {
  // The engine hands diff the props object itself; only its values may be unresolved.
  const next = news as { [K in keyof AssetProps]?: Input<AssetProps[K]> };
  let action: "update" | undefined;
  const keys = new Set([...Object.keys(olds), ...Object.keys(next)]) as Set<keyof AssetProps>;
  for (const key of keys) {
    const value: unknown = next[key];
    if (isResolved(value) && deepEqual(olds[key], value)) continue;
    if (!UPDATABLE.has(key)) return "replace";
    if (key === "inputs" && !sameSource(olds.inputs, next.inputs)) return "replace";
    action = "update";
  }
  return action;
};

/** Items of `items` left after removing one deep-equal match per item of `remove`. */
const without = <T>(items: T[], remove: T[]) => {
  const rest = [...remove];
  return items.filter((item) => {
    const i = rest.findIndex((r) => deepEqual(r, item));
    if (i >= 0) rest.splice(i, 1);
    return i < 0;
  });
};

const describe = (t: { type?: string; language_code?: string; name?: string }) =>
  `${t.type ?? "text"} track ${t.language_code ?? ""}${t.name ? ` "${t.name}"` : ""}`.trim();

const matchesInput = (input: TrackInput) => (t: Video.Track) =>
  (t.type === "text" ? t.text_source === "uploaded" : t.type === "audio" && t.primary !== true) &&
  t.type === input.type &&
  t.language_code === input.language_code &&
  (t.type !== "text" || (t.text_type ?? "subtitles") === (input.text_type ?? "subtitles")) &&
  (input.name === undefined || t.name === input.name);

const matchesGenerated = (settings: GeneratedSubtitles) => (t: Video.Track) =>
  t.text_source === "generated_vod" &&
  (settings.language_code === undefined ||
    settings.language_code === "auto" ||
    t.language_code === settings.language_code) &&
  (settings.name === undefined || t.name === settings.name);

const directiveIds = (props: AssetProps | undefined) =>
  (props?.directives ?? []).map((directive) => directive.id);

const POLL_INTERVAL = Duration.seconds(2);
const READY_TIMEOUT = Duration.minutes(30);

const toAttrs = (asset: Video.Asset): AssetAttributes => {
  const playback_ids = sortPlaybackIds(asset.playback_ids);
  return {
    id: asset.id,
    created_at: asset.created_at,
    status: asset.status,
    duration: asset.duration,
    aspect_ratio: asset.aspect_ratio,
    resolution_tier: asset.resolution_tier,
    max_resolution_tier: asset.max_resolution_tier,
    video_quality: asset.video_quality,
    test: asset.test,
    passthrough: asset.passthrough,
    meta: asset.meta,
    master_access: asset.master_access,
    master: asset.master,
    thumbnail_time: asset.thumbnail_time,
    playback_ids,
    static_renditions: asset.static_renditions,
    tracks: asset.tracks ?? [],
    directives: asset.directives,
    errors: asset.errors,
    ...playbackIdsByPolicy(playback_ids),
  };
};

export const AssetProvider = () =>
  Provider.effect(
    Asset,
    Effect.gen(function* () {
      const createAsset = yield* Video.createAsset;
      const getAsset = yield* Video.getAsset;
      const updateAsset = yield* Video.updateAsset;
      const deleteAsset = yield* Video.deleteAsset;
      const listAssets = yield* Video.listAssets;
      const deleteThumbnailTime = yield* Video.deleteAssetThumbnailTime;
      const updateMasterAccess = yield* Video.updateAssetMasterAccess;
      const createPlaybackId = yield* Video.createAssetPlaybackId;
      const deletePlaybackId = yield* Video.deleteAssetPlaybackId;
      const createRendition = yield* Video.createAssetStaticRendition;
      const deleteRendition = yield* Video.deleteAssetStaticRendition;
      const createTrack = yield* Video.createAssetTrack;
      const deleteTrack = yield* Video.deleteAssetTrack;
      const generateSubtitles = yield* Video.generateAssetTrackSubtitles;
      const runDirective = yield* Robots.runDirective;

      const get = (id: string) => getAsset({ ASSET_ID: id }).pipe(Effect.map((res) => res.data));

      const waitForReady = (id: string) =>
        Effect.gen(function* () {
          for (;;) {
            const asset = yield* get(id);
            const settled = !asset.tracks?.some((t) => t.status === "preparing");
            if (asset.status === "ready" && settled) {
              const failed = asset.tracks?.find((t) => t.status === "errored");
              if (failed === undefined) return asset;
              yield* deleteAsset({ ASSET_ID: id }).pipe(Effect.ignore);
              return yield* new AssetIngestFailed({
                id,
                reason: `the ${describe(failed)} errored`,
              });
            }
            if (asset.status === "errored") {
              yield* deleteAsset({ ASSET_ID: id }).pipe(Effect.ignore);
              const reason =
                asset.errors?.messages?.join("; ") ?? asset.errors?.type ?? "unknown error";
              return yield* new AssetIngestFailed({ id, reason });
            }
            yield* Effect.sleep(POLL_INTERVAL);
          }
        }).pipe(Effect.timeout(READY_TIMEOUT));

      const create = Effect.fn(function* (news: AssetProps) {
        const { wait_for_ready, thumbnail_time: _, ...body } = news;
        // A create that failed with a 5xx may still have happened, so it is
        // retried only on throttling.
        const { data: created } = yield* createAsset(body).pipe(MuxRetry.throttling);
        return wait_for_ready === false ? created : yield* waitForReady(created.id);
      });

      const syncTracks = Effect.fn(function* (
        asset: Video.Asset,
        olds: AssetProps | undefined,
        news: AssetProps,
      ) {
        const ASSET_ID = asset.id;
        const before = splitInputs(olds?.inputs);
        const after = splitInputs(news.inputs);
        const existing = (asset.tracks ?? []).flatMap((t) =>
          t.id === undefined ? [] : [{ ...t, id: t.id }],
        );
        const claimed = new Set<string>();
        const unclaimed = (matches: (t: Video.Track) => boolean) =>
          existing.filter((t) => !claimed.has(t.id) && matches(t));

        const audio =
          existing.find((t) => t.type === "audio" && t.primary) ??
          existing.find((t) => t.type === "audio");
        const addTrack = (input: TrackInput) =>
          createTrack({
            ASSET_ID,
            url: input.url,
            type: input.type,
            text_type: input.text_type,
            language_code: input.language_code,
            name: input.name,
            closed_captions: input.closed_captions,
            passthrough: input.passthrough,
          }).pipe(
            MuxRetry.throttling,
            Effect.map((res) => [res.data]),
          );
        const generate = (subtitles: GeneratedSubtitles[]) =>
          audio === undefined
            ? Effect.fail(
                new AssetTrackFailed({
                  id: ASSET_ID,
                  track: "generated subtitles (the asset has no audio)",
                }),
              )
            : generateSubtitles({
                ASSET_ID,
                TRACK_ID: audio.id,
                generated_subtitles: subtitles,
              }).pipe(
                MuxRetry.throttling,
                Effect.map((res) => res.data),
              );

        // Each removed track carries the request that recreates it, for rollback.
        const doomed: { id: string; restore: Effect.Effect<void> }[] = [];
        const removals = [
          ...without(before.tracks, after.tracks).map(
            (input) => [describe(input), matchesInput(input), addTrack(input)] as const,
          ),
          ...without(before.subtitles, after.subtitles).map(
            (settings) =>
              [
                describe({ ...settings, name: settings.name ?? "generated" }),
                matchesGenerated(settings),
                generate([settings]),
              ] as const,
          ),
        ];
        for (const [label, matches, restore] of removals) {
          const found = unclaimed(matches);
          if (found.length > 1)
            return yield* new AssetTrackAmbiguous({ id: ASSET_ID, track: label });
          for (const t of found) {
            claimed.add(t.id);
            doomed.push({ id: t.id, restore: restore.pipe(Effect.ignore) });
          }
        }

        // Every declared track Mux does not have is added, so a track deleted
        // outside Alchemy, or lost to an interrupted deploy, comes back.
        const missing = (matches: (t: Video.Track) => boolean) => {
          const [present] = unclaimed(matches);
          if (present !== undefined) claimed.add(present.id);
          return present === undefined;
        };
        const addedInputs = after.tracks.filter((input) => missing(matchesInput(input)));
        const addedSubtitles = after.subtitles.filter((settings) =>
          missing(matchesGenerated(settings)),
        );

        const removed: Effect.Effect<void>[] = [];
        const added: Video.Track[] = [];
        yield* Effect.gen(function* () {
          // Mux requires unique track names, so a replaced track goes before its successor.
          for (const { id, restore } of doomed) {
            yield* deleteTrack({ ASSET_ID, TRACK_ID: id }).pipe(
              Effect.catchTag("NotFound", () => Effect.void),
            );
            removed.push(restore);
          }
          for (const input of addedInputs) {
            const tracks = yield* addTrack(input);
            added.push(...tracks);
          }
          if (addedSubtitles.length > 0) {
            const tracks = yield* generate(addedSubtitles);
            added.push(...tracks);
          }
          if (news.wait_for_ready === false || added.length === 0) return;
          for (;;) {
            const current = yield* get(ASSET_ID);
            const mine = (current.tracks ?? []).filter((t) => added.some((a) => a.id === t.id));
            const failed = mine.find((t) => t.status === "errored");
            if (failed !== undefined) {
              return yield* new AssetTrackFailed({ id: ASSET_ID, track: describe(failed) });
            }
            if (!mine.some((t) => t.status === "preparing")) return;
            yield* Effect.sleep(POLL_INTERVAL);
          }
        }).pipe(
          Effect.timeout(READY_TIMEOUT),
          Effect.onError(() =>
            Effect.gen(function* () {
              for (const t of added) {
                if (t.id === undefined) continue;
                yield* deleteTrack({ ASSET_ID, TRACK_ID: t.id }).pipe(Effect.ignore);
              }
              for (const restore of removed) yield* restore;
            }),
          ),
        );
      });

      /** Brings the asset to what `news` describes, comparing with Mux rather than with `olds`. */
      const sync = Effect.fn(function* (
        asset: Video.Asset,
        olds: AssetProps | undefined,
        news: AssetProps,
      ) {
        const ASSET_ID = asset.id;
        const passthrough =
          (news.passthrough ?? "") === (asset.passthrough ?? "")
            ? undefined
            : (news.passthrough ?? "");
        const meta = metaWrite({ ...news.meta }, { ...asset.meta });
        const thumbnail_time =
          news.thumbnail_time !== undefined && news.thumbnail_time !== asset.thumbnail_time
            ? news.thumbnail_time
            : undefined;
        if (passthrough !== undefined || meta !== undefined || thumbnail_time !== undefined) {
          yield* updateAsset({ ASSET_ID, passthrough, meta, thumbnail_time });
        }
        if (news.thumbnail_time === undefined && asset.thumbnail_time !== undefined) {
          yield* deleteThumbnailTime({ ASSET_ID });
        }

        const master_access = news.master_access ?? "none";
        if (master_access !== (asset.master_access ?? "none")) {
          yield* updateMasterAccess({ ASSET_ID, master_access });
        }

        // Playback IDs are managed only when the props declare policies.
        if (news.playback_policies !== undefined || news.advanced_playback_policies !== undefined) {
          const wanted = [
            ...(news.playback_policies ?? []).map((policy) => ({ policy })),
            ...(news.advanced_playback_policies ?? []),
          ];
          const { create, remove } = playbackIdChanges(wanted, asset.playback_ids ?? []);
          for (const want of create) {
            yield* createPlaybackId({ ASSET_ID, ...want }).pipe(MuxRetry.throttling);
          }
          for (const stale of remove) {
            yield* deletePlaybackId({ ASSET_ID, PLAYBACK_ID: stale.id }).pipe(
              Effect.catchTag("NotFound", () => Effect.void),
            );
          }
        }

        // Mux adds renditions and tracks only to a ready asset, and a
        // preparing one may not list what its create requested yet.
        if (asset.status !== "ready") return;

        const desired = news.static_renditions ?? [];
        const files = (asset.static_renditions?.files ?? []).flatMap((f) =>
          f.id === undefined ? [] : [{ ...f, id: f.id }],
        );
        for (const rendition of desired) {
          if (!files.some((f) => f.resolution === rendition.resolution)) {
            yield* createRendition({ ASSET_ID, ...rendition }).pipe(MuxRetry.throttling);
          }
        }
        for (const file of files.filter(
          (f) => !desired.some((r) => r.resolution === f.resolution),
        )) {
          yield* deleteRendition({ ASSET_ID, STATIC_RENDITION_ID: file.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }

        yield* syncTracks(asset, olds, news);

        // Runs are events, not state: only newly listed directives start one,
        // and a new or adopted asset starts none beyond what its create ran.
        const before = olds === undefined ? undefined : directiveIds(olds);
        for (const id of directiveIds(news)) {
          if (before === undefined || before.includes(id)) continue;
          yield* runDirective({ DIRECTIVE_ID: id, asset_id: ASSET_ID }).pipe(MuxRetry.throttling);
        }
      });

      return {
        stables: ["id", "created_at"],
        list: () =>
          listAssets.items({ limit: 100 }).pipe(
            Stream.runCollect,
            Effect.map((assets) => assets.map(toAttrs)),
          ),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output?.id) return undefined;
          const action = plan(olds ?? {}, news);
          return action === undefined ? undefined : ({ action } as const);
        }),
        reconcile: Effect.fn(function* ({ news, olds, output }) {
          if (output?.id && olds !== undefined && plan(olds, news) === "replace") {
            return yield* new AssetImmutableChange({ id: output.id });
          }
          const observed = output?.id
            ? yield* get(output.id).pipe(Effect.catchTag("NotFound", () => Effect.undefined))
            : undefined;
          const asset = observed ?? (yield* create(news));
          // A new asset has no history to compare tracks and directive runs with.
          yield* sync(asset, observed === undefined ? undefined : olds, news);
          const final = yield* get(asset.id);
          return toAttrs(final);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteAsset({ ASSET_ID: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* get(output.id).pipe(
            Effect.map(toAttrs),
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
        }),
      };
    }),
  );
