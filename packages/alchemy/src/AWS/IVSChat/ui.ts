import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { LoggingConfiguration } from "./LoggingConfiguration.ts";
import type { Room } from "./Room.ts";

/**
 * Dashboard UI providers for AWS IVSChat resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Media Services (IVS Chat) brand orange. */
const COLOR = "#ED7100";

export const LoggingConfigurationUI = UIProvider.succeed<LoggingConfiguration>(
  "AWS.IVSChat.LoggingConfiguration",
  {
    displayName: "IVS Chat Logging Configuration",
    icon: "scroll-text",
    color: COLOR,
    category: "media",
    summary: (ctx) => ctx.attrs?.loggingConfigurationName,
    facts: (ctx) => [
      {
        label: "name",
        value: ctx.attrs?.loggingConfigurationName,
        copy: true,
      },
      {
        label: "id",
        value: ctx.attrs?.loggingConfigurationId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.loggingConfigurationArn,
        mono: true,
        copy: true,
      },
      { label: "state", value: ctx.attrs?.state },
      {
        label: "destination",
        value: ctx.props?.destinationConfiguration?.s3
          ? "s3"
          : ctx.props?.destinationConfiguration?.cloudWatchLogs
            ? "cloudwatch logs"
            : ctx.props?.destinationConfiguration?.firehose
              ? "firehose"
              : undefined,
      },
    ],
  },
);

export const RoomUI = UIProvider.succeed<Room>("AWS.IVSChat.Room", {
  displayName: "IVS Chat Room",
  icon: "message-square",
  color: COLOR,
  category: "media",
  summary: (ctx) => ctx.attrs?.roomName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.roomName, copy: true },
    { label: "id", value: ctx.attrs?.roomId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.roomArn, mono: true, copy: true },
    {
      label: "max message rate",
      value: ctx.props?.maximumMessageRatePerSecond,
    },
    { label: "max message length", value: ctx.props?.maximumMessageLength },
  ],
});

export const ui = () => Layer.mergeAll(LoggingConfigurationUI, RoomUI);
