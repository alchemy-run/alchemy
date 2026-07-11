import { Endpoint } from "@distilled.cloud/aws";
import * as kv from "@distilled.cloud/aws/kinesis-video";
import * as kvs from "@distilled.cloud/aws/kinesis-video-signaling";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  GetIceServerConfig,
  type GetIceServerConfigRequest,
} from "./GetIceServerConfig.ts";
import { discoverSignalingEndpoint } from "./internal.ts";
import type { SignalingChannel } from "./SignalingChannel.ts";

export const GetIceServerConfigHttp = Layer.effect(
  GetIceServerConfig,
  Effect.gen(function* () {
    // Yield-first captures the operations' services (Credentials/Region/
    // HttpClient) at layer init so the runtime callable is requirement-free.
    const getSignalingChannelEndpoint = yield* kv.getSignalingChannelEndpoint;
    const getIceServerConfig = yield* kvs.getIceServerConfig;

    return Effect.fn(function* <C extends SignalingChannel>(channel: C) {
      const ChannelArn = yield* channel.channelArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.KinesisVideo.GetIceServerConfig(${channel}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [
                    // the data plane requires per-channel endpoint discovery
                    "kinesisvideo:GetSignalingChannelEndpoint",
                    "kinesisvideo:GetIceServerConfig",
                  ],
                  Resource: [channel.channelArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.KinesisVideo.GetIceServerConfig(${channel.LogicalId})`,
      )(function* (request?: GetIceServerConfigRequest) {
        const channelArn = yield* ChannelArn;
        // GetIceServerConfig is served by the channel's HTTPS signaling
        // endpoint; the MASTER role endpoint answers for either peer role.
        const endpoint = yield* discoverSignalingEndpoint(
          channelArn,
          "HTTPS",
          "MASTER",
          getSignalingChannelEndpoint,
        );
        return yield* getIceServerConfig({
          ...request,
          ChannelARN: channelArn,
        }).pipe(
          Effect.provideService(Endpoint.Endpoint, Effect.succeed(endpoint)),
        );
      });
    });
  }),
);
