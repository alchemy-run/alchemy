import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { SignalingChannel } from "./SignalingChannel.ts";
import type { Stream } from "./Stream.ts";

/**
 * Dashboard UI providers for AWS Kinesis Video Streams resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#8C4FFF";

export const SignalingChannelUI = UIProvider.succeed<SignalingChannel>(
  "AWS.KinesisVideo.SignalingChannel",
  {
    displayName: "Kinesis Video Signaling Channel",
    icon: "radio",
    color: COLOR,
    category: "media",
    summary: (ctx) => ctx.attrs?.channelName,
    facts: (ctx) => [
      { label: "channel", value: ctx.attrs?.channelName, copy: true },
      { label: "arn", value: ctx.attrs?.channelArn, mono: true, copy: true },
      { label: "type", value: ctx.props?.type },
    ],
  },
);

export const StreamUI = UIProvider.succeed<Stream>("AWS.KinesisVideo.Stream", {
  displayName: "Kinesis Video Stream",
  icon: "video",
  color: COLOR,
  category: "media",
  summary: (ctx) => ctx.attrs?.streamName,
  facts: (ctx) => [
    { label: "stream", value: ctx.attrs?.streamName, copy: true },
    { label: "arn", value: ctx.attrs?.streamArn, mono: true, copy: true },
    { label: "media type", value: ctx.props?.mediaType },
    { label: "device", value: ctx.props?.deviceName },
  ],
});

export const ui = () => Layer.mergeAll(SignalingChannelUI, StreamUI);
