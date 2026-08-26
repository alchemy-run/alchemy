import * as streetviewpublish from "@distilled.cloud/gcp/streetviewpublish_v1";
import * as Layer from "effect/Layer";
import { makePhotoSequenceHttpBinding } from "./BindingHttp.ts";
import { GetPhotoSequence } from "./GetPhotoSequence.ts";

/**
 * HTTP implementation of {@link GetPhotoSequence}.
 *
 * @layer
 * @provides GCP.Streetviewpublish.GetPhotoSequence
 */
export const GetPhotoSequenceHttp = Layer.effect(
  GetPhotoSequence,
  makePhotoSequenceHttpBinding({
    tag: "GCP.Streetviewpublish.GetPhotoSequence",
    operation: streetviewpublish.getPhotoSequence,
  }),
);
