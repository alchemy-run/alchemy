import type * as kv from "@distilled.cloud/aws/kinesis-video";
import type * as kvam from "@distilled.cloud/aws/kinesis-video-archived-media";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface GetHLSStreamingSessionURLRequest extends Omit<
  kvam.GetHLSStreamingSessionURLInput,
  "StreamName" | "StreamARN"
> {}

/**
 * Runtime binding for `kinesisvideo:GetHLSStreamingSessionURL` (archived
 * media data plane).
 *
 * Bind this operation to a `Stream` inside a function runtime to get a
 * callable that resolves the per-stream data endpoint (`GetDataEndpoint`)
 * and returns a short-lived HLS playback URL.
 * @binding
 * @section Reading Media
 * @example Live HLS Playback URL
 * ```typescript
 * // init
 * const getHls = yield* AWS.KinesisVideo.GetHLSStreamingSessionURL(stream);
 *
 * // runtime
 * const { HLSStreamingSessionURL } = yield* getHls({
 *   PlaybackMode: "LIVE",
 * });
 * ```
 */
export interface GetHLSStreamingSessionURL extends Binding.Service<
  GetHLSStreamingSessionURL,
  "AWS.KinesisVideo.GetHLSStreamingSessionURL",
  <S extends Stream>(
    stream: S,
  ) => Effect.Effect<
    (
      request?: GetHLSStreamingSessionURLRequest,
    ) => Effect.Effect<
      kvam.GetHLSStreamingSessionURLOutput,
      kvam.GetHLSStreamingSessionURLError | kv.GetDataEndpointError
    >
  >
> {}

export const GetHLSStreamingSessionURL =
  Binding.Service<GetHLSStreamingSessionURL>(
    "AWS.KinesisVideo.GetHLSStreamingSessionURL",
  );
