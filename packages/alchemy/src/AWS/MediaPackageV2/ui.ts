import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Channel } from "./Channel.ts";
import type { ChannelGroup } from "./ChannelGroup.ts";
import type { OriginEndpoint } from "./OriginEndpoint.ts";

/**
 * Dashboard UI providers for AWS MediaPackageV2 resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Media Services (MediaPackage) brand orange. */
const COLOR = "#ED7100";

export const ChannelGroupUI = UIProvider.succeed<ChannelGroup>(
  "AWS.MediaPackageV2.ChannelGroup",
  {
    displayName: "MediaPackage Channel Group",
    icon: "folder",
    color: COLOR,
    category: "media",
    summary: (ctx) => ctx.attrs?.channelGroupName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.channelGroupName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.channelGroupArn,
        mono: true,
        copy: true,
      },
      {
        label: "egress domain",
        value: ctx.attrs?.egressDomain,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ChannelUI = UIProvider.succeed<Channel>(
  "AWS.MediaPackageV2.Channel",
  {
    displayName: "MediaPackage Channel",
    icon: "video",
    color: COLOR,
    category: "media",
    summary: (ctx) => ctx.attrs?.channelName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.channelName, copy: true },
      { label: "group", value: ctx.attrs?.channelGroupName, mono: true },
      { label: "arn", value: ctx.attrs?.channelArn, mono: true, copy: true },
      { label: "input type", value: ctx.attrs?.inputType },
      {
        label: "ingest endpoints",
        value: ctx.attrs?.ingestEndpoints?.length,
      },
    ],
  },
);

export const OriginEndpointUI = UIProvider.succeed<OriginEndpoint>(
  "AWS.MediaPackageV2.OriginEndpoint",
  {
    displayName: "MediaPackage Origin Endpoint",
    icon: "share-2",
    color: COLOR,
    category: "media",
    summary: (ctx) => ctx.attrs?.originEndpointName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.originEndpointName, copy: true },
      { label: "channel", value: ctx.attrs?.channelName, mono: true },
      { label: "group", value: ctx.attrs?.channelGroupName, mono: true },
      {
        label: "arn",
        value: ctx.attrs?.originEndpointArn,
        mono: true,
        copy: true,
      },
      { label: "container type", value: ctx.attrs?.containerType },
      { label: "hls manifests", value: ctx.attrs?.hlsManifests?.length },
      { label: "dash manifests", value: ctx.attrs?.dashManifests?.length },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(ChannelGroupUI, ChannelUI, OriginEndpointUI);
