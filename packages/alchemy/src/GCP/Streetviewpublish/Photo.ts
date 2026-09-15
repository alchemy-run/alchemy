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
  DEFAULT_LAT_LNG,
  DEFAULT_PHOTO_CONTENT_TYPE,
  decodeBase64,
  deletePhoto,
  desiredPhotoPose,
  findOwnedPhoto,
  getPhoto,
  hasAlchemyPhotoMarker,
  jsonEqual,
  listOwnedPhotos,
  ownershipLabels,
  photoIdOf,
  photoOwnedByAlchemy,
  startPhotoUpload,
  updateMaskOf,
  uploadMedia,
} from "./internal.ts";

export type PhotoPose = {
  /** Altitude in meters above the WGS84 ellipsoid. */
  altitude?: number;
  /** Pitch at the photo center, degrees in `[-90, 90]`. */
  pitch?: number;
  /** Roll in degrees in `[0, 360)`. */
  roll?: number;
  /**
   * Indoor floor. Street View photos have no labels field, so Alchemy
   * overwrites this with ownership (`name` `alc` and a hash `number`)
   * for `list` / nuke.
   */
  level?: streetviewpublish.Level;
  /** WGS84 latitude and longitude. Required to publish a photo. */
  latLngPair?: streetviewpublish.LatLng;
  /** GPS record time since the UTC epoch. */
  gpsRecordTimestampUnixEpoch?: string;
  /** Compass heading in degrees clockwise from north. */
  heading?: number;
  /** Horizontal accuracy in meters (one standard deviation). */
  accuracyMeters?: number;
};

export type PhotoConnection = {
  /** Destination photo id this photo links to. */
  target?: { id?: string };
};

export type PhotoPlace = {
  /** Localized place name (output only). */
  name?: string;
  /** Google Place id. */
  placeId?: string;
  /** Language of `name` (output only). */
  languageCode?: string;
};

export type PhotoProps = {
  /**
   * Street View photo id. Server-assigned on create. Immutable —
   * changing it replaces the photo.
   */
  photoId?: string;
  /**
   * Upload URL from `photo.startUpload`. If omitted on create, Alchemy
   * starts an upload session. Immutable — changing it replaces the
   * photo (pixels cannot be updated).
   */
  uploadUrl?: string;
  /**
   * Base64-encoded JPEG bytes. Required on create unless `uploadUrl`
   * already holds uploaded bytes. Must be a 360 photo with Photo Sphere
   * XMP metadata. Immutable — changing it replaces the photo.
   */
  photoBytes?: string;
  /**
   * Content type of `photoBytes`.
   * @default "image/jpeg"
   */
  mediaType?: string;
  /**
   * Pose. Create ignores heading, pitch, roll, altitude, and level;
   * those fields are written on the following update. Alchemy stamps
   * `pose.level` with ownership.
   */
  pose?: PhotoPose;
  /**
   * Links from this photo to other photos.
   */
  connections?: PhotoConnection[];
  /**
   * Absolute capture time. Used when the JPEG has no EXIF timestamp.
   */
  captureTime?: string;
  /**
   * Places this photo belongs to.
   */
  places?: PhotoPlace[];
};

export type Photo = Resource<
  "GCP.Streetviewpublish.Photo",
  PhotoProps,
  {
    /** Street View photo id. */
    photoId: string;
    /** Project id used when the photo was reconciled. */
    project: string;
    /** Share link. */
    shareLink: string | undefined;
    /** Thumbnail URL. */
    thumbnailUrl: string | undefined;
    /** Download URL when requested with `INCLUDE_DOWNLOAD_URL`. */
    downloadUrl: string | undefined;
    /** View count. */
    viewCount: string | undefined;
    /** Google Maps publish status. */
    mapsPublishStatus: string | undefined;
    /** Rights-transfer status. */
    transferStatus: string | undefined;
    /** Pose, including the Alchemy ownership level. */
    pose: PhotoPose | undefined;
    /** Connections to other photos. */
    connections: PhotoConnection[];
    /** Associated places. */
    places: PhotoPlace[];
    /** Capture time. */
    captureTime: string | undefined;
    /** Upload time. */
    uploadTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Street View Publish 360 photo.
 *
 * Photos have no labels field, so Alchemy stamps ownership into
 * `pose.level` (`name` `alc` plus a hash `number`) for `list` / nuke.
 * Photo id is identity — changing it replaces the photo. Pixel bytes
 * are immutable after create; pose, connections, and places update in
 * place.
 *
 * ### Creating a Photo
 * **Example:** Upload JPEG bytes
 * ```typescript
 * const photo = yield* GCP.Streetviewpublish.Photo("Corner", {
 *   photoBytes: jpegBase64,
 *   pose: {
 *     latLngPair: { latitude: 37.422, longitude: -122.084 },
 *   },
 * });
 * ```
 *
 * **Example:** Existing upload URL
 * ```typescript
 * const photo = yield* GCP.Streetviewpublish.Photo("Corner", {
 *   uploadUrl: session.uploadUrl,
 *   pose: {
 *     latLngPair: { latitude: 37.422, longitude: -122.084 },
 *   },
 * });
 * ```
 *
 * ### Updating a Photo
 * **Example:** Change heading
 * ```typescript
 * const photo = yield* GCP.Streetviewpublish.Photo("Corner", {
 *   photoId: existing.photoId,
 *   pose: {
 *     latLngPair: { latitude: 37.422, longitude: -122.084 },
 *     heading: 90,
 *   },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Streetviewpublish
 */
export const Photo = Resource<Photo>("GCP.Streetviewpublish.Photo");

export class PhotoNotResolved extends Data.TaggedError(
  "GCP.Streetviewpublish.PhotoNotResolved",
)<{
  photoId: string;
}> {}

const poseOf = (
  pose: streetviewpublish.Pose | undefined,
): PhotoPose | undefined => {
  if (pose === undefined) return undefined;
  return {
    altitude: pose.altitude,
    pitch: pose.pitch,
    roll: pose.roll,
    level: pose.level,
    latLngPair: pose.latLngPair,
    gpsRecordTimestampUnixEpoch: pose.gpsRecordTimestampUnixEpoch,
    heading: pose.heading,
    accuracyMeters: pose.accuracyMeters,
  };
};

const connectionsOf = (
  connections: streetviewpublish.ConnectionList | undefined,
): PhotoConnection[] =>
  (connections ?? []).map((connection) => ({
    target: connection.target ? { id: connection.target.id } : undefined,
  }));

const placesOf = (
  places: streetviewpublish.PlaceList | undefined,
): PhotoPlace[] =>
  (places ?? []).map((place) => ({
    name: place.name,
    placeId: place.placeId,
    languageCode: place.languageCode,
  }));

const toAttrs = (photo: streetviewpublish.Photo, project: string) => ({
  photoId: photoIdOf(photo),
  project,
  shareLink: photo.shareLink,
  thumbnailUrl: photo.thumbnailUrl,
  downloadUrl: photo.downloadUrl,
  viewCount: photo.viewCount,
  mapsPublishStatus: photo.mapsPublishStatus,
  transferStatus: photo.transferStatus,
  pose: poseOf(photo.pose),
  connections: connectionsOf(photo.connections),
  places: placesOf(photo.places),
  captureTime: photo.captureTime,
  uploadTime: photo.uploadTime,
});

const refresh = (photoId: string, fallback: streetviewpublish.Photo) =>
  getPhoto(photoId).pipe(Effect.map((fresh) => fresh ?? fallback));

export const PhotoProvider = () =>
  Provider.succeed(Photo, {
    stables: ["photoId", "project", "uploadTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.photoId ?? output?.photoId;
      if (
        previousId !== undefined &&
        news.photoId !== undefined &&
        news.photoId !== previousId
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
      const previousBytes = olds?.photoBytes;
      if (
        previousBytes !== undefined &&
        news.photoBytes !== undefined &&
        news.photoBytes !== previousBytes
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const photoId = olds?.photoId ?? output?.photoId ?? "";
      let existing = yield* getPhoto(photoId);
      if (existing === undefined) {
        existing = yield* findOwnedPhoto(id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* photoOwnedByAlchemy(id, existing))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const photos = yield* listOwnedPhotos();
        return photos
          .filter(hasAlchemyPhotoMarker)
          .map((photo) => toAttrs(photo, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const labels = yield* ownershipLabels(id);
      const pose = desiredPhotoPose(labels, news.pose, undefined);
      const connections = news.connections;
      const places = news.places;

      let current = yield* getPhoto(news.photoId ?? output?.photoId ?? "");
      if (current === undefined) {
        current = yield* findOwnedPhoto(id);
      }

      if (current === undefined) {
        const started =
          news.uploadUrl !== undefined && news.uploadUrl.length > 0
            ? { uploadUrl: news.uploadUrl }
            : yield* startPhotoUpload();
        const uploadUrl = started.uploadUrl ?? news.uploadUrl;
        if (uploadUrl === undefined || uploadUrl.length === 0) {
          return yield* new PhotoNotResolved({
            photoId: news.photoId ?? output?.photoId ?? "",
          });
        }
        if (news.photoBytes !== undefined && news.photoBytes.length > 0) {
          const bytes = yield* decodeBase64(news.photoBytes);
          yield* uploadMedia(
            uploadUrl,
            bytes,
            news.mediaType ?? DEFAULT_PHOTO_CONTENT_TYPE,
          );
        }
        const created = yield* streetviewpublish
          .createPhoto({
            body: {
              uploadReference: { uploadUrl },
              pose: {
                latLngPair: pose.latLngPair ?? DEFAULT_LAT_LNG,
              },
              connections,
              captureTime: news.captureTime,
              places,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwnedPhoto(id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PhotoNotResolved({
          photoId: news.photoId ?? output?.photoId ?? "",
        });
      }

      const photoId =
        photoIdOf(current) || news.photoId || output?.photoId || "";
      const desiredPose = desiredPhotoPose(labels, news.pose, current.pose);
      const poseChanged = !jsonEqual(current.pose, desiredPose);
      const connectionsChanged =
        connections !== undefined &&
        !jsonEqual(connectionsOf(current.connections), connections);
      const placesChanged =
        places !== undefined && !jsonEqual(placesOf(current.places), places);

      if (poseChanged || connectionsChanged || placesChanged) {
        const fields: string[] = [];
        if (poseChanged) {
          fields.push(
            "pose.heading",
            "pose.lat_lng_pair",
            "pose.pitch",
            "pose.roll",
            "pose.level",
            "pose.altitude",
          );
        }
        if (connectionsChanged) fields.push("connections");
        if (placesChanged) fields.push("places");
        current = yield* streetviewpublish
          .updatePhoto({
            id: photoId,
            updateMask: updateMaskOf(fields),
            body: {
              pose: desiredPose,
              connections: connectionsChanged
                ? connections
                : current.connections,
              places: placesChanged ? places : current.places,
            },
          })
          .pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed(current as streetviewpublish.Photo),
            ),
          );
      }

      const fresh = yield* refresh(photoIdOf(current) || photoId, current);
      return toAttrs(fresh, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deletePhoto(output.photoId);
    }),
  });
