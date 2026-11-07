import type * as kv from "@distilled.cloud/aws/kinesis-video";
import * as kvam from "@distilled.cloud/aws/kinesis-video-archived-media";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeStreamMediaHttpBinding } from "./BindingHttp.ts";
import type { Stream } from "./Stream.ts";

export interface GetMediaForFragmentListRequest extends Omit<
  kvam.GetMediaForFragmentListInput,
  "StreamName" | "StreamARN"
> {}

/**
 * Runtime binding for `kinesisvideo:GetMediaForFragmentList` (archived
 * media data plane).
 *
 * Bind this operation to a `Stream` inside a function runtime to get a
 * callable that resolves the per-stream data endpoint (`GetDataEndpoint`)
 * and downloads MKV-packaged media for an explicit list of fragment
 * numbers (typically discovered via `ListFragments`). The response
 * `Payload` is a streaming body.
 * ### Reading Media
 * **Example:** Fetch Media for Specific Fragments
 * ```typescript
 * // init
 * const getFragmentMedia =
 *   yield* AWS.KinesisVideo.GetMediaForFragmentList(stream);
 *
 * // runtime
 * const media = yield* getFragmentMedia({
 *   Fragments: fragments.map((f) => f.FragmentNumber!),
 * });
 * ```
 *
 * @binding
 */
export interface GetMediaForFragmentList extends Binding.Service<
  GetMediaForFragmentList,
  "AWS.KinesisVideo.GetMediaForFragmentList",
  <S extends Stream>(
    stream: S,
  ) => Effect.Effect<
    (
      request: GetMediaForFragmentListRequest,
    ) => Effect.Effect<
      kvam.GetMediaForFragmentListOutput,
      kvam.GetMediaForFragmentListError | kv.GetDataEndpointError
    >
  >
> {}

export const GetMediaForFragmentList = Binding.Service<GetMediaForFragmentList>(
  "AWS.KinesisVideo.GetMediaForFragmentList",
);

export const GetMediaForFragmentListHttp = Layer.effect(
  GetMediaForFragmentList,
  makeStreamMediaHttpBinding({
    tag: "AWS.KinesisVideo.GetMediaForFragmentList",
    apiName: "GET_MEDIA_FOR_FRAGMENT_LIST",
    actions: ["kinesisvideo:GetMediaForFragmentList"],
    operation: kvam.getMediaForFragmentList,
  }),
);
