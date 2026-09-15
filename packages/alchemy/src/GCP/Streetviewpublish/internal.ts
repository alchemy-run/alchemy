import * as streetviewpublish from "@distilled.cloud/gcp/streetviewpublish_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { GcpEnvironment } from "../Environment.ts";
import { alchemyLabelKeys, createInternalLabels } from "../Labels.ts";

export const LEVEL_NAME = "alc";
export const DEFAULT_VIEW = "BASIC" as const;
export const DEFAULT_PHOTO_CONTENT_TYPE = "image/jpeg";
export const DEFAULT_SEQUENCE_CONTENT_TYPE = "video/mp4";
export const DEFAULT_SEQUENCE_INPUT_TYPE = "VIDEO" as const;
export const DEFAULT_LAT_LNG: streetviewpublish.LatLng = {
  latitude: 37.422,
  longitude: -122.084,
};

export class MediaUploadFailed extends Data.TaggedError(
  "GCP.Streetviewpublish.MediaUploadFailed",
)<{
  uploadUrl: string;
  status: number;
}> {}

const emptyList = <A>() => Effect.succeed([] as A[]);

export const lastSegment = (value: string | undefined) => {
  const trimmed = (value ?? "").replace(/\/+$/, "");
  if (trimmed.length === 0) return "";
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameNumber = (
  left: number | undefined,
  right: number | undefined,
) => left === right;

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const ownershipLabels = (id: string) => createInternalLabels(id);

/** Distinctive indoor-level number derived from Alchemy ownership labels. */
export const ownershipLevelNumber = (labels: Record<string, string>) => {
  const key = `${labels[alchemyLabelKeys.stack] ?? ""}:${labels[alchemyLabelKeys.stage] ?? ""}:${labels[alchemyLabelKeys.id] ?? ""}`;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 900000 + ((hash >>> 0) % 100000);
};

export const ownershipLevel = (
  labels: Record<string, string>,
): streetviewpublish.Level => ({
  name: LEVEL_NAME,
  number: ownershipLevelNumber(labels),
});

export const hasAlchemyLevel = (level: streetviewpublish.Level | undefined) =>
  (level?.name ?? "") === LEVEL_NAME;

export const hasAlchemyPhotoMarker = (photo: streetviewpublish.Photo) =>
  hasAlchemyLevel(photo.pose?.level);

export const photoOwnedByAlchemy = (
  id: string,
  photo: streetviewpublish.Photo,
) =>
  Effect.gen(function* () {
    if (!hasAlchemyPhotoMarker(photo)) return false;
    const labels = yield* ownershipLabels(id);
    return sameNumber(photo.pose?.level?.number, ownershipLevelNumber(labels));
  });

export const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" | "Forbidden" } =>
        error._tag === "NotFound" || error._tag === "Forbidden",
      () => Effect.succeed(undefined),
    ),
  );

export const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" | "Forbidden" } =>
        error._tag === "NotFound" || error._tag === "Forbidden",
      () => Effect.void,
    ),
  );

export const decodeBase64 = (value: string) =>
  Effect.sync(() => new Uint8Array(Buffer.from(value, "base64")));

export const uploadMedia = (
  uploadUrl: string,
  bytes: Uint8Array,
  contentType: string,
) =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.put(uploadUrl).pipe(
        HttpClientRequest.setHeader(
          "Authorization",
          `Bearer ${Redacted.value(env.accessToken)}`,
        ),
        HttpClientRequest.bodyUint8Array(bytes, contentType),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new MediaUploadFailed({
        uploadUrl,
        status: response.status,
      });
    }
  });

export const startPhotoUpload = () =>
  streetviewpublish
    .startUploadPhoto({ body: {} })
    .pipe(
      Effect.catchTag("NotFound", () =>
        Effect.succeed({} as streetviewpublish.UploadRef),
      ),
    );

export const startSequenceUpload = () =>
  streetviewpublish
    .startUploadPhotoSequence({ body: {} })
    .pipe(
      Effect.catchTag("NotFound", () =>
        Effect.succeed({} as streetviewpublish.UploadRef),
      ),
    );

export const getPhoto = (photoId: string) =>
  photoId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        streetviewpublish.getPhoto({
          photoId,
          view: DEFAULT_VIEW,
        }),
      );

export const getPhotoSequenceOperation = (sequenceId: string) =>
  sequenceId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        streetviewpublish.getPhotoSequence({
          sequenceId,
          view: DEFAULT_VIEW,
        }),
      );

export const listPhotos = () =>
  streetviewpublish.listPhotos
    .pages({
      view: DEFAULT_VIEW,
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.photos ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => emptyList<streetviewpublish.Photo>()),
      Effect.catchTag("Forbidden", () => emptyList<streetviewpublish.Photo>()),
    );

export const listPhotoSequenceOperations = () =>
  streetviewpublish.listPhotoSequences
    .pages({
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.photoSequences ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        emptyList<streetviewpublish.Operation>(),
      ),
      Effect.catchTag("Forbidden", () =>
        emptyList<streetviewpublish.Operation>(),
      ),
    );

export const listOwnedPhotos = () =>
  listPhotos().pipe(
    Effect.map((photos) => photos.filter(hasAlchemyPhotoMarker)),
  );

export const findOwnedPhoto = (id: string) =>
  Effect.gen(function* () {
    const photos = yield* listOwnedPhotos();
    for (const photo of photos) {
      if (yield* photoOwnedByAlchemy(id, photo)) {
        return photo;
      }
    }
    return undefined;
  });

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null || value === undefined || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
};

const stringOf = (value: unknown) =>
  typeof value === "string" ? value : undefined;

const numberOf = (value: unknown) =>
  typeof value === "number" ? value : undefined;

const photoFromUnknown = (
  value: unknown,
): streetviewpublish.Photo | undefined => {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const photoId = asRecord(record.photoId);
  return {
    downloadUrl: stringOf(record.downloadUrl),
    viewCount: stringOf(record.viewCount),
    mapsPublishStatus: stringOf(record.mapsPublishStatus),
    photoId:
      photoId !== undefined
        ? { id: stringOf(photoId.id) }
        : typeof record.photoId === "string"
          ? { id: record.photoId }
          : undefined,
    shareLink: stringOf(record.shareLink),
    pose: asRecord(record.pose) as streetviewpublish.Pose | undefined,
    connections: record.connections as
      | streetviewpublish.ConnectionList
      | undefined,
    transferStatus: stringOf(record.transferStatus),
    thumbnailUrl: stringOf(record.thumbnailUrl),
    captureTime: stringOf(record.captureTime),
    places: record.places as streetviewpublish.PlaceList | undefined,
    uploadTime: stringOf(record.uploadTime),
  };
};

export const sequenceFromOperation = (
  operation: streetviewpublish.Operation,
): streetviewpublish.PhotoSequence => {
  const response = asRecord(operation.response);
  const id =
    stringOf(response?.id) ||
    lastSegment(operation.name) ||
    lastSegment(stringOf(asRecord(operation.metadata)?.id));
  const photos = Array.isArray(response?.photos)
    ? (response.photos as unknown[])
        .map(photoFromUnknown)
        .filter(
          (photo): photo is streetviewpublish.Photo => photo !== undefined,
        )
    : undefined;
  const rawGpsTimeline = Array.isArray(response?.rawGpsTimeline)
    ? (response.rawGpsTimeline as streetviewpublish.PoseList)
    : undefined;
  return {
    id,
    uploadTime: stringOf(response?.uploadTime),
    failureReason: stringOf(response?.failureReason),
    photos,
    processingState:
      stringOf(response?.processingState) ??
      (operation.done === true
        ? operation.error
          ? "FAILED"
          : "PROCESSED"
        : "PROCESSING"),
    captureTimeOverride: stringOf(response?.captureTimeOverride),
    failureDetails: asRecord(response?.failureDetails) as
      | streetviewpublish.ProcessingFailureDetails
      | undefined,
    gpsSource: stringOf(response?.gpsSource),
    rawGpsTimeline,
    distanceMeters: numberOf(response?.distanceMeters),
    sequenceBounds: asRecord(response?.sequenceBounds) as
      | streetviewpublish.LatLngBounds
      | undefined,
    viewCount: stringOf(response?.viewCount),
    filename: stringOf(response?.filename),
  };
};

export const hasAlchemySequenceMarker = (
  sequence: streetviewpublish.PhotoSequence,
) =>
  (sequence.photos ?? []).some(hasAlchemyPhotoMarker) ||
  (sequence.rawGpsTimeline ?? []).some((pose) => hasAlchemyLevel(pose.level));

export const sequenceOwnedByAlchemy = (
  id: string,
  sequence: streetviewpublish.PhotoSequence,
) =>
  Effect.gen(function* () {
    const labels = yield* ownershipLabels(id);
    const number = ownershipLevelNumber(labels);
    const matchLevel = (level: streetviewpublish.Level | undefined) =>
      hasAlchemyLevel(level) && sameNumber(level?.number, number);
    if (
      (sequence.photos ?? []).some((photo) => matchLevel(photo.pose?.level))
    ) {
      return true;
    }
    return (sequence.rawGpsTimeline ?? []).some((pose) =>
      matchLevel(pose.level),
    );
  });

export const getPhotoSequence = (sequenceId: string) =>
  Effect.gen(function* () {
    const operation = yield* getPhotoSequenceOperation(sequenceId);
    if (operation === undefined) return undefined;
    return sequenceFromOperation(operation);
  });

export const listOwnedSequences = () =>
  Effect.gen(function* () {
    const operations = yield* listPhotoSequenceOperations();
    const sequences = yield* Effect.forEach(
      operations.filter((operation) => lastSegment(operation.name).length > 0),
      (operation) =>
        getPhotoSequence(lastSegment(operation.name)).pipe(
          Effect.map(
            (sequence) => sequence ?? sequenceFromOperation(operation),
          ),
        ),
      { concurrency: 4 },
    );
    return sequences.filter(hasAlchemySequenceMarker);
  });

export const findOwnedSequence = (id: string) =>
  Effect.gen(function* () {
    const sequences = yield* listOwnedSequences();
    for (const sequence of sequences) {
      if (yield* sequenceOwnedByAlchemy(id, sequence)) {
        return sequence;
      }
    }
    return undefined;
  });

export const deletePhoto = (photoId: string) =>
  photoId.length === 0
    ? Effect.void
    : ignoreMissing(streetviewpublish.deletePhoto({ photoId }));

export const deletePhotoSequence = (sequenceId: string) =>
  sequenceId.length === 0
    ? Effect.void
    : streetviewpublish.deletePhotoSequence({ sequenceId }).pipe(
        Effect.retry({
          while: (error) =>
            error._tag === "Conflict" || error._tag === "BadRequest",
          schedule: Schedule.spaced("2 seconds"),
          times: 8,
        }),
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("Forbidden", () => Effect.void),
        Effect.catchTag("Conflict", () => Effect.void),
        Effect.catchTag("BadRequest", () => Effect.void),
      );

export const desiredPhotoPose = (
  labels: Record<string, string>,
  pose: streetviewpublish.Pose | undefined,
  current: streetviewpublish.Pose | undefined,
): streetviewpublish.Pose => ({
  ...current,
  ...pose,
  latLngPair: pose?.latLngPair ?? current?.latLngPair ?? DEFAULT_LAT_LNG,
  level: ownershipLevel(labels),
});

export const desiredSequenceGpsTimeline = (
  labels: Record<string, string>,
  timeline: streetviewpublish.PoseList | undefined,
): streetviewpublish.PoseList => {
  const marker: streetviewpublish.Pose = {
    latLngPair: DEFAULT_LAT_LNG,
    level: ownershipLevel(labels),
    gpsRecordTimestampUnixEpoch: "1970-01-01T00:00:00Z",
  };
  const rest = (timeline ?? []).filter((pose) => !hasAlchemyLevel(pose.level));
  return [marker, ...rest];
};

export const photoIdOf = (photo: streetviewpublish.Photo | undefined) =>
  photo?.photoId?.id ?? "";

export const updateMaskOf = (fields: string[]) =>
  fields.length > 0 ? fields.join(",") : undefined;
