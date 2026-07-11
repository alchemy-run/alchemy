import { Endpoint } from "@distilled.cloud/aws";
import * as kv from "@distilled.cloud/aws/kinesis-video";
import * as kvm from "@distilled.cloud/aws/kinesis-video-media";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { GetMedia, type GetMediaRequest } from "./GetMedia.ts";
import { discoverDataEndpoint } from "./internal.ts";
import type { Stream } from "./Stream.ts";

export const GetMediaHttp = Layer.effect(
  GetMedia,
  Effect.gen(function* () {
    // Yield-first captures the operations' services (Credentials/Region/
    // HttpClient) at layer init so the runtime callable is requirement-free.
    const getDataEndpoint = yield* kv.getDataEndpoint;
    const getMedia = yield* kvm.getMedia;

    return Effect.fn(function* <S extends Stream>(stream: S) {
      const StreamArn = yield* stream.streamArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.KinesisVideo.GetMedia(${stream}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [
                    // the data plane requires per-stream endpoint discovery
                    "kinesisvideo:GetDataEndpoint",
                    "kinesisvideo:GetMedia",
                  ],
                  Resource: [stream.streamArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.KinesisVideo.GetMedia(${stream.LogicalId})`)(
        function* (request: GetMediaRequest) {
          const streamArn = yield* StreamArn;
          const endpoint = yield* discoverDataEndpoint(
            streamArn,
            "GET_MEDIA",
            getDataEndpoint,
          );
          return yield* getMedia({
            ...request,
            StreamARN: streamArn,
          }).pipe(
            Effect.provideService(Endpoint.Endpoint, Effect.succeed(endpoint)),
          );
        },
      );
    });
  }),
);
