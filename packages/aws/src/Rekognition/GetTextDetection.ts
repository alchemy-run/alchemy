import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `rekognition:GetTextDetection` — get the results of an asynchronous text detection job started by StartTextDetection.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:GetTextDetection` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.GetTextDetectionHttp)`.
 *
 * ### Video Analysis
 * **Example:** Poll Text Detection Results
 * ```typescript
 * // init
 * const getTextDetection = yield* AWS.Rekognition.GetTextDetection();
 *
 * // runtime
 * const results = yield* getTextDetection({ JobId: jobId });
 * if (results.JobStatus === "SUCCEEDED") {
 *   // consume the detections
 * }
 * ```
 *
 * @binding
 */
export interface GetTextDetection extends Binding.Service<
  GetTextDetection,
  "AWS.Rekognition.GetTextDetection",
  () => Effect.Effect<
    (
      request: rekognition.GetTextDetectionRequest,
    ) => Effect.Effect<rekognition.GetTextDetectionResponse, rekognition.GetTextDetectionError>
  >
> {}
export const GetTextDetection = Binding.Service<GetTextDetection>(
  "AWS.Rekognition.GetTextDetection",
);

export const GetTextDetectionHttp = Layer.effect(
  GetTextDetection,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.GetTextDetection",
    operation: rekognition.getTextDetection,
    actions: ["rekognition:GetTextDetection"],
  }),
);
