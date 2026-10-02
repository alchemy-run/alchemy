import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Channel } from "./Channel.ts";
import type { PlaybackKeyPair } from "./PlaybackKeyPair.ts";
import type { PlaybackRestrictionPolicy } from "./PlaybackRestrictionPolicy.ts";
import type { RecordingConfiguration } from "./RecordingConfiguration.ts";
import type { StreamKey } from "./StreamKey.ts";

/**
 * Dashboard UI providers for AWS IVS resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const IVS_COLOR = "#ED7100";

export const ChannelUI = UIProvider.succeed<Channel>("AWS.IVS.Channel", {
  displayName: "IVS Channel",
  icon: "video",
  color: IVS_COLOR,
  category: "media",
  summary: (ctx) => ctx.attrs?.channelName,
  link: (ctx) => ctx.attrs?.playbackUrl,
  facts: (ctx) => [
    { label: "channel", value: ctx.attrs?.channelName, copy: true },
    { label: "arn", value: ctx.attrs?.channelArn, mono: true, copy: true },
    { label: "ingest", value: ctx.attrs?.ingestEndpoint, mono: true },
    {
      label: "playback",
      value: ctx.attrs?.playbackUrl,
      href: ctx.attrs?.playbackUrl,
      copy: true,
    },
    { label: "type", value: ctx.attrs?.type },
    { label: "latency mode", value: ctx.attrs?.latencyMode },
    { label: "authorized", value: ctx.attrs?.authorized },
  ],
});

export const PlaybackKeyPairUI = UIProvider.succeed<PlaybackKeyPair>(
  "AWS.IVS.PlaybackKeyPair",
  {
    displayName: "IVS Playback Key Pair",
    icon: "key",
    color: IVS_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.playbackKeyPairName,
    facts: (ctx) => [
      {
        label: "key pair",
        value: ctx.attrs?.playbackKeyPairName,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.playbackKeyPairArn,
        mono: true,
        copy: true,
      },
      { label: "fingerprint", value: ctx.attrs?.fingerprint, mono: true },
    ],
  },
);

export const PlaybackRestrictionPolicyUI =
  UIProvider.succeed<PlaybackRestrictionPolicy>(
    "AWS.IVS.PlaybackRestrictionPolicy",
    {
      displayName: "IVS Playback Restriction Policy",
      icon: "shield",
      color: IVS_COLOR,
      category: "security",
      summary: (ctx) => ctx.attrs?.playbackRestrictionPolicyName,
      facts: (ctx) => [
        {
          label: "policy",
          value: ctx.attrs?.playbackRestrictionPolicyName,
          copy: true,
        },
        {
          label: "arn",
          value: ctx.attrs?.playbackRestrictionPolicyArn,
          mono: true,
          copy: true,
        },
        {
          label: "countries",
          value: ctx.attrs?.allowedCountries?.join(", "),
        },
        { label: "origins", value: ctx.attrs?.allowedOrigins?.join(", ") },
        {
          label: "strict origin",
          value: ctx.attrs?.enableStrictOriginEnforcement,
        },
      ],
    },
  );

export const RecordingConfigurationUI =
  UIProvider.succeed<RecordingConfiguration>("AWS.IVS.RecordingConfiguration", {
    displayName: "IVS Recording Configuration",
    icon: "film",
    color: IVS_COLOR,
    category: "media",
    summary: (ctx) => ctx.attrs?.recordingConfigurationName,
    facts: (ctx) => [
      {
        label: "config",
        value: ctx.attrs?.recordingConfigurationName,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.recordingConfigurationArn,
        mono: true,
        copy: true,
      },
      { label: "bucket", value: ctx.attrs?.bucketName, mono: true },
      { label: "state", value: ctx.attrs?.state },
    ],
  });

export const StreamKeyUI = UIProvider.succeed<StreamKey>("AWS.IVS.StreamKey", {
  displayName: "IVS Stream Key",
  icon: "key-round",
  color: IVS_COLOR,
  category: "security",
  summary: (ctx) => ctx.attrs?.streamKeyArn,
  facts: (ctx) => [
    { label: "arn", value: ctx.attrs?.streamKeyArn, mono: true, copy: true },
    { label: "channel", value: ctx.attrs?.channelArn, mono: true },
  ],
});

export const ui = () =>
  Layer.mergeAll(
    ChannelUI,
    PlaybackKeyPairUI,
    PlaybackRestrictionPolicyUI,
    RecordingConfigurationUI,
    StreamKeyUI,
  );
