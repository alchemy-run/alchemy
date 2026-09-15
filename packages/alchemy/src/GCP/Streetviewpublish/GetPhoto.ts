import type * as streetviewpublish from "@distilled.cloud/gcp/streetviewpublish_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Photo } from "./Photo.ts";

export interface GetPhotoRequest extends Omit<
  streetviewpublish.GetPhotoRequest,
  "photoId"
> {}

/**
 * Runtime binding for Street View Publish `photo.get`.
 *
 * Bind this operation to a {@link Photo} in a Function/Action init
 * phase. Provide {@link GetPhotoHttp}.
 *
 * ### Reading Photos
 * **Example:** Read photo metadata
 * ```typescript
 * const getPhoto = yield* GCP.Streetviewpublish.GetPhoto(photo);
 * const metadata = yield* getPhoto({ view: "BASIC" });
 * ```
 *
 * @binding
 * @product GCP
 * @category Streetviewpublish
 */
export interface GetPhoto extends Binding.Service<
  GetPhoto,
  "GCP.Streetviewpublish.GetPhoto",
  (
    photo: Photo,
  ) => Effect.Effect<
    (
      request: GetPhotoRequest,
    ) => Effect.Effect<
      streetviewpublish.Photo,
      streetviewpublish.GetPhotoError,
      RuntimeContext
    >
  >
> {}

export const GetPhoto = Binding.Service<GetPhoto>(
  "GCP.Streetviewpublish.GetPhoto",
);
