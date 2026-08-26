import type * as streetviewpublish from "@distilled.cloud/gcp/streetviewpublish_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { PhotoSequence } from "./PhotoSequence.ts";

export interface GetPhotoSequenceRequest extends Omit<
  streetviewpublish.GetPhotoSequenceRequest,
  "sequenceId"
> {}

/**
 * Runtime binding for Street View Publish `photoSequence.get`.
 *
 * Bind this operation to a {@link PhotoSequence} in a Function/Action
 * init phase. Provide {@link GetPhotoSequenceHttp}. The API returns a
 * long-running Operation wrapping the sequence.
 *
 * ### Reading Photo Sequences
 * **Example:** Read sequence metadata
 * ```typescript
 * const getSequence = yield* GCP.Streetviewpublish.GetPhotoSequence(
 *   sequence,
 * );
 * const operation = yield* getSequence({ view: "BASIC" });
 * ```
 *
 * @binding
 * @product GCP
 * @category Streetviewpublish
 */
export interface GetPhotoSequence extends Binding.Service<
  GetPhotoSequence,
  "GCP.Streetviewpublish.GetPhotoSequence",
  (
    sequence: PhotoSequence,
  ) => Effect.Effect<
    (
      request: GetPhotoSequenceRequest,
    ) => Effect.Effect<
      streetviewpublish.Operation,
      streetviewpublish.GetPhotoSequenceError,
      RuntimeContext
    >
  >
> {}

export const GetPhotoSequence = Binding.Service<GetPhotoSequence>(
  "GCP.Streetviewpublish.GetPhotoSequence",
);
