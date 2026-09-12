import * as streetviewpublish from "@distilled.cloud/gcp/streetviewpublish_v1";
import * as Layer from "effect/Layer";
import { makePhotoHttpBinding } from "./BindingHttp.ts";
import { GetPhoto } from "./GetPhoto.ts";

/**
 * HTTP implementation of {@link GetPhoto}.
 *
 * @layer
 * @provides GCP.Streetviewpublish.GetPhoto
 */
export const GetPhotoHttp = Layer.effect(
  GetPhoto,
  makePhotoHttpBinding({
    tag: "GCP.Streetviewpublish.GetPhoto",
    operation: streetviewpublish.getPhoto,
  }),
);
