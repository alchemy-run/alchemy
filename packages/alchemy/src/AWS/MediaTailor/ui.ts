import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { PlaybackConfiguration } from "./PlaybackConfiguration.ts";

/**
 * Dashboard UI providers for AWS MediaTailor resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const PlaybackConfigurationUI =
  UIProvider.succeed<PlaybackConfiguration>(
    "AWS.MediaTailor.PlaybackConfiguration",
    {
      displayName: "MediaTailor Playback Configuration",
      icon: "play",
      color: "#ED7100",
      category: "media",
      summary: (ctx) => ctx.attrs?.name,
      facts: (ctx) => [
        { label: "config", value: ctx.attrs?.name, copy: true },
        {
          label: "arn",
          value: ctx.attrs?.playbackConfigurationArn,
          mono: true,
          copy: true,
        },
        {
          label: "playback endpoint",
          value: ctx.attrs?.playbackEndpointPrefix,
          mono: true,
        },
        {
          label: "ad decision server",
          value: ctx.props?.adDecisionServerUrl,
          mono: true,
        },
        {
          label: "content source",
          value: ctx.props?.videoContentSourceUrl,
          mono: true,
        },
      ],
    },
  );

export const ui = () => Layer.mergeAll(PlaybackConfigurationUI);
