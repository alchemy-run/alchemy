import { Endpoint } from "@distilled.cloud/aws";
import * as kv from "@distilled.cloud/aws/kinesis-video";
import * as kvam from "@distilled.cloud/aws/kinesis-video-archived-media";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  GetHLSStreamingSessionURL,
  type GetHLSStreamingSessionURLRequest,
} from "./GetHLSStreamingSessionURL.ts";
import { discoverDataEndpoint } from "./internal.ts";
import type { Stream } from "./Stream.ts";

export const GetHLSStreamingSessionURLHttp = Layer.effect(
  GetHLSStreamingSessionURL,
  Effect.gen(function* () {
    // Yield-first captures the operations' services (Credentials/Region/
    // HttpClient) at layer init so the runtime callable is requirement-free.
    const getDataEndpoint = yield* kv.getDataEndpoint;
    const getHLSStreamingSessionURL = yield* kvam.getHLSStreamingSessionURL;

    return Effect.fn(function* <S extends Stream>(stream: S) {
      const StreamArn = yield* stream.streamArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.KinesisVideo.GetHLSStreamingSessionURL(${stream}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [
                    // the data plane requires per-stream endpoint discovery
                    "kinesisvideo:GetDataEndpoint",
                    "kinesisvideo:GetHLSStreamingSessionURL",
                  ],
                  Resource: [stream.streamArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.KinesisVideo.GetHLSStreamingSessionURL(${stream.LogicalId})`,
      )(function* (request?: GetHLSStreamingSessionURLRequest) {
        const streamArn = yield* StreamArn;
        const endpoint = yield* discoverDataEndpoint(
          streamArn,
          "GET_HLS_STREAMING_SESSION_URL",
          getDataEndpoint,
        );
        return yield* getHLSStreamingSessionURL({
          ...request,
          StreamARN: streamArn,
        }).pipe(
          Effect.provideService(Endpoint.Endpoint, Effect.succeed(endpoint)),
        );
      });
    });
  }),
);
