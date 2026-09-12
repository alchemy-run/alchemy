import * as streetviewpublish from "@distilled.cloud/gcp/streetviewpublish_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_SEQUENCE_CONTENT_TYPE,
  DEFAULT_SEQUENCE_INPUT_TYPE,
  decodeBase64,
  deletePhotoSequence,
  desiredSequenceGpsTimeline,
  findOwnedSequence,
  getPhotoSequence,
  hasAlchemySequenceMarker,
  lastSegment,
  listOwnedSequences,
  ownershipLabels,
  photoIdOf,
  sequenceOwnedByAlchemy,
  startSequenceUpload,
  uploadMedia,
} from "./internal.ts";

export type PhotoSequenceProps = {
  /**
   * Street View photo sequence id. Server-assigned on create (also the
   * long-running operation id). Immutable — changing it replaces the
   * sequence.
   */
  sequenceId?: string;
  /**
   * Input form of the uploaded bytes.
   * @default "VIDEO"
   */
  inputType?:
    | streetviewpublish.CreatePhotoSequenceInputTypeEnum
    | (string & {});
  /**
   * Upload URL from `photoSequence.startUpload`. If omitted on create,
   * Alchemy starts an upload session. Immutable — there is no update
   * API, so changing it replaces the sequence.
   */
  uploadUrl?: string;
  /**
   * Base64-encoded video or XDM bytes. Required on create unless
   * `uploadUrl` already holds uploaded bytes. Immutable — changing it
   * replaces the sequence.
   */
  sequenceBytes?: string;
  /**
   * Content type of `sequenceBytes`.
   * @default "video/mp4"
   */
  mediaType?: string;
  /**
   * Capture start time. Overrides timestamps in the video or XDM file.
   * Immutable after create.
   */
  captureTimeOverride?: string;
  /**
   * Which GPS source wins when both `rawGpsTimeline` and CAMM contain
   * GPS. Immutable after create.
   */
  gpsSource?: streetviewpublish.PhotoSequenceGpsSourceEnum | (string & {});
  /**
   * Raw GPS measurements. Alchemy prepends an ownership pose
   * (`pose.level.name` `alc`) for `list` / nuke.
   */
  rawGpsTimeline?: streetviewpublish.PoseList;
  /**
   * Three-axis IMU samples. Prefer the CAMM track when this payload is
   * large. Immutable after create.
   */
  imu?: streetviewpublish.Imu;
};

export type PhotoSequence = Resource<
  "GCP.Streetviewpublish.PhotoSequence",
  PhotoSequenceProps,
  {
    /** Photo sequence id. */
    sequenceId: string;
    /** Project id used when the sequence was reconciled. */
    project: string;
    /** Processing state. */
    processingState: string | undefined;
    /** Failure reason when processing failed. */
    failureReason: string | undefined;
    /** Upload time. */
    uploadTime: string | undefined;
    /** Capture start time. */
    captureTimeOverride: string | undefined;
    /** Computed distance in meters. */
    distanceMeters: number | undefined;
    /** Total view count across published frames. */
    viewCount: string | undefined;
    /** Original filename, when the upload platform provided one. */
    filename: string | undefined;
    /** Photo ids extracted from the sequence, once processed. */
    photoIds: string[];
  },
  never,
  Providers
>;

/**
 * A Google Street View Publish photo sequence (video or XDM).
 *
 * Sequences have no labels field and no update API, so Alchemy stamps
 * ownership into a `rawGpsTimeline` pose (`pose.level.name` `alc`) for
 * `list` / nuke. Sequence id and media are identity — changing them
 * replaces the sequence. Create returns a long-running operation;
 * processing may finish asynchronously.
 *
 * ### Creating a Photo Sequence
 * **Example:** Upload a video
 * ```typescript
 * const sequence = yield* GCP.Streetviewpublish.PhotoSequence("Walk", {
 *   sequenceBytes: mp4Base64,
 *   inputType: "VIDEO",
 *   rawGpsTimeline: [
 *     {
 *       latLngPair: { latitude: 37.422, longitude: -122.084 },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Existing upload URL
 * ```typescript
 * const sequence = yield* GCP.Streetviewpublish.PhotoSequence("Walk", {
 *   uploadUrl: session.uploadUrl,
 *   inputType: "VIDEO",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Streetviewpublish
 */
export const PhotoSequence = Resource<PhotoSequence>(
  "GCP.Streetviewpublish.PhotoSequence",
);

export class PhotoSequenceNotResolved extends Data.TaggedError(
  "GCP.Streetviewpublish.PhotoSequenceNotResolved",
)<{
  sequenceId: string;
}> {}

const toAttrs = (
  sequence: streetviewpublish.PhotoSequence,
  project: string,
) => ({
  sequenceId: sequence.id ?? "",
  project,
  processingState: sequence.processingState,
  failureReason: sequence.failureReason,
  uploadTime: sequence.uploadTime,
  captureTimeOverride: sequence.captureTimeOverride,
  distanceMeters: sequence.distanceMeters,
  viewCount: sequence.viewCount,
  filename: sequence.filename,
  photoIds: (sequence.photos ?? [])
    .map((photo) => photoIdOf(photo))
    .filter((photoId) => photoId.length > 0),
});

export const PhotoSequenceProvider = () =>
  Provider.succeed(PhotoSequence, {
    stables: ["sequenceId", "project", "uploadTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.sequenceId ?? output?.sequenceId;
      if (
        previousId !== undefined &&
        news.sequenceId !== undefined &&
        news.sequenceId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (
        olds?.inputType !== undefined &&
        news.inputType !== undefined &&
        news.inputType !== olds.inputType
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousUpload = olds?.uploadUrl;
      if (
        previousUpload !== undefined &&
        news.uploadUrl !== undefined &&
        news.uploadUrl !== previousUpload
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousBytes = olds?.sequenceBytes;
      if (
        previousBytes !== undefined &&
        news.sequenceBytes !== undefined &&
        news.sequenceBytes !== previousBytes
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (
        olds?.captureTimeOverride !== undefined &&
        news.captureTimeOverride !== undefined &&
        news.captureTimeOverride !== olds.captureTimeOverride
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const sequenceId = olds?.sequenceId ?? output?.sequenceId ?? "";
      let existing = yield* getPhotoSequence(sequenceId);
      if (existing === undefined) {
        existing = yield* findOwnedSequence(id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* sequenceOwnedByAlchemy(id, existing)) ||
        output !== undefined
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const sequences = yield* listOwnedSequences();
        return sequences
          .filter(hasAlchemySequenceMarker)
          .map((sequence) => toAttrs(sequence, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const labels = yield* ownershipLabels(id);
      const inputType = news.inputType ?? DEFAULT_SEQUENCE_INPUT_TYPE;
      const rawGpsTimeline = desiredSequenceGpsTimeline(
        labels,
        news.rawGpsTimeline,
      );

      let current = yield* getPhotoSequence(
        news.sequenceId ?? output?.sequenceId ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedSequence(id);
      }

      if (current === undefined) {
        const started =
          news.uploadUrl !== undefined && news.uploadUrl.length > 0
            ? { uploadUrl: news.uploadUrl }
            : yield* startSequenceUpload();
        const uploadUrl = started.uploadUrl ?? news.uploadUrl;
        if (uploadUrl === undefined || uploadUrl.length === 0) {
          return yield* new PhotoSequenceNotResolved({
            sequenceId: news.sequenceId ?? output?.sequenceId ?? "",
          });
        }
        if (news.sequenceBytes !== undefined && news.sequenceBytes.length > 0) {
          const bytes = yield* decodeBase64(news.sequenceBytes);
          yield* uploadMedia(
            uploadUrl,
            bytes,
            news.mediaType ?? DEFAULT_SEQUENCE_CONTENT_TYPE,
          );
        }
        const created = yield* streetviewpublish
          .createPhotoSequence({
            inputType,
            body: {
              uploadReference: { uploadUrl },
              captureTimeOverride: news.captureTimeOverride,
              gpsSource: news.gpsSource,
              rawGpsTimeline,
              imu: news.imu,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedSequence(id).pipe(
                Effect.map((sequence) =>
                  sequence ? { name: sequence.id, done: true } : undefined,
                ),
              ),
            ),
          );
        const sequenceId =
          lastSegment(created?.name) ||
          news.sequenceId ||
          output?.sequenceId ||
          "";
        current =
          (yield* getPhotoSequence(sequenceId)) ??
          (sequenceId.length > 0
            ? { id: sequenceId, processingState: "PENDING" }
            : undefined);
      }

      if (current === undefined) {
        return yield* new PhotoSequenceNotResolved({
          sequenceId: news.sequenceId ?? output?.sequenceId ?? "",
        });
      }

      const fresh =
        (yield* getPhotoSequence(current.id ?? output?.sequenceId ?? "")) ??
        current;
      return toAttrs(fresh, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deletePhotoSequence(output.sequenceId);
    }),
  });
