import * as youtube from "@distilled.cloud/gcp/youtube_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_CATEGORY,
  DEFAULT_PRIVACY,
  hasOwnershipMarker,
  ownedByAlchemy,
  ownedDescription,
  ownedTitle,
  parseDescription,
} from "./internal.ts";

export type VideoProps = {
  /**
   * Video title. If omitted, a unique name is generated.
   */
  title?: string;
  /**
   * Video description. YouTube videos have no labels field, so Alchemy
   * stamps ownership into a `[alchemy …]` prefix and strips it from
   * attributes.
   */
  description?: string;
  /**
   * YouTube category id.
   * @default "22"
   */
  categoryId?: string;
  /**
   * Tags.
   */
  tags?: string[];
  /**
   * Privacy status (`private`, `unlisted`, `public`).
   * @default "private"
   */
  privacyStatus?: string;
  /**
   * Existing video id. Omit on create; pass the observed id to update
   * in place. Immutable — changing it replaces the video.
   */
  videoId?: string;
};

export type Video = Resource<
  "GCP.Youtube.Video",
  VideoProps,
  {
    /** YouTube video id. */
    videoId: string;
    /** Title. */
    title: string | undefined;
    /** Description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Category id. */
    categoryId: string | undefined;
    /** Tags. */
    tags: string[] | undefined;
    /** Channel id. */
    channelId: string | undefined;
    /** Privacy status. */
    privacyStatus: string | undefined;
    /** Upload status. */
    uploadStatus: string | undefined;
    /** Resource kind (`youtube#video`). */
    kind: string | undefined;
    /** Project id used when the video was reconciled. */
    project: string;
  },
  never,
  Providers
>;

/**
 * A YouTube video.
 *
 * Videos have no labels — Alchemy stamps ownership into
 * `snippet.description`. Distilled `insertVideos` is JSON-only (no
 * resumable media upload); creating a video without an out-of-band
 * upload will be rejected by the API. Updates and deletes work against
 * an existing `videoId`.
 *
 * ### Creating a Video
 * **Example:** Private metadata (requires media upload support)
 * ```typescript
 * const video = yield* GCP.Youtube.Video("Clip", {
 *   title: "alchemy-clip",
 *   privacyStatus: "private",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Youtube
 */
export const Video = Resource<Video>("GCP.Youtube.Video");

export class VideoNotResolved extends Data.TaggedError(
  "GCP.Youtube.VideoNotResolved",
)<{
  videoId: string;
}> {}

const PARTS = ["snippet", "status"];

const toAttrs = (video: youtube.Video, project: string) => ({
  videoId: video.id ?? "",
  title: video.snippet?.title,
  description: parseDescription(video.snippet?.description).description,
  categoryId: video.snippet?.categoryId,
  tags: video.snippet?.tags,
  channelId: video.snippet?.channelId,
  privacyStatus: video.status?.privacyStatus,
  uploadStatus: video.status?.uploadStatus,
  kind: video.kind,
  project,
});

const getById = (videoId: string) =>
  videoId.length === 0
    ? Effect.succeed(undefined)
    : youtube.listVideos({ part: PARTS, id: [videoId] }).pipe(
        Effect.map((page) => page.items?.[0]),
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          Effect.succeed(undefined),
        ),
      );

const listMine = () =>
  youtube.listSearch
    .pages({
      part: ["snippet"],
      forMine: true,
      type: ["video"],
      maxResults: 50,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.items ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed([] as youtube.SearchResult[]),
      ),
    );

export const VideoProvider = () =>
  Provider.succeed(Video, {
    stables: ["videoId", "channelId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.videoId ?? output?.videoId;
      if (
        previousId !== undefined &&
        news.videoId !== undefined &&
        news.videoId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* getById(olds?.videoId ?? output?.videoId ?? "");
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.snippet?.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const search = yield* listMine();
        const ids = search
          .map((item) => item.id?.videoId)
          .filter((id): id is string => !!id);
        if (ids.length === 0) return [];
        const page = yield* youtube
          .listVideos({ part: PARTS, id: ids })
          .pipe(
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed({ items: [] as youtube.VideoList }),
            ),
          );
        return (page.items ?? [])
          .filter((video) => hasOwnershipMarker(video.snippet?.description))
          .map((video) => toAttrs(video, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const title = yield* ownedTitle(id, news.title, output?.title);
      const description = yield* ownedDescription(
        id,
        news.description,
        parseDescription(output?.description).description,
      );
      const categoryId =
        news.categoryId ?? output?.categoryId ?? DEFAULT_CATEGORY;
      const privacyStatus =
        news.privacyStatus ?? output?.privacyStatus ?? DEFAULT_PRIVACY;

      let current = yield* getById(news.videoId ?? output?.videoId ?? "");

      if (current === undefined) {
        const created = yield* youtube
          .insertVideos({
            part: PARTS,
            notifySubscribers: false,
            body: {
              snippet: {
                title,
                description,
                categoryId,
                tags: news.tags,
              },
              status: { privacyStatus },
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getById(news.videoId ?? output?.videoId ?? ""),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined || !current.id) {
        return yield* new VideoNotResolved({
          videoId: news.videoId ?? output?.videoId ?? title,
        });
      }

      const titleChanged = (current.snippet?.title ?? "") !== title;
      const descriptionChanged =
        (current.snippet?.description ?? "") !== description;
      const categoryChanged =
        (current.snippet?.categoryId ?? "") !== categoryId;
      const tagsChanged =
        JSON.stringify([...(current.snippet?.tags ?? [])].sort()) !==
        JSON.stringify([...(news.tags ?? current.snippet?.tags ?? [])].sort());
      const privacyChanged =
        (current.status?.privacyStatus ?? "") !== privacyStatus;

      if (
        titleChanged ||
        descriptionChanged ||
        categoryChanged ||
        tagsChanged ||
        privacyChanged
      ) {
        current = yield* youtube.updateVideos({
          part: PARTS,
          body: {
            id: current.id,
            snippet: {
              title,
              description,
              categoryId,
              tags: news.tags ?? current.snippet?.tags,
            },
            status: { privacyStatus },
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.videoId) return;
      yield* youtube
        .deleteVideos({ id: output.videoId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
