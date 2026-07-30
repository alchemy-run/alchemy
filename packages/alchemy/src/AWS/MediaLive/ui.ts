import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Channel } from "./Channel.ts";
import type { Input } from "./Input.ts";
import type { InputSecurityGroup } from "./InputSecurityGroup.ts";

/**
 * Dashboard UI providers for AWS MediaLive resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined) => arn?.split(":")[3];

export const ChannelUI = UIProvider.succeed<Channel>("AWS.MediaLive.Channel", {
  displayName: "MediaLive Channel",
  icon: "video",
  color: "#ED7100",
  category: "media",
  summary: (ctx) => ctx.attrs?.channelName ?? ctx.attrs?.channelId,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.channelArn);
    return ctx.attrs?.channelId === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/medialive/home?region=${region}#/channels/${ctx.attrs.channelId}`;
  },
  facts: (ctx) => [
    { label: "channel", value: ctx.attrs?.channelName, copy: true },
    { label: "id", value: ctx.attrs?.channelId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.channelArn, mono: true, copy: true },
    { label: "state", value: ctx.attrs?.state },
    { label: "class", value: ctx.attrs?.channelClass },
    {
      label: "egress endpoints",
      value: ctx.attrs?.egressEndpoints?.length,
    },
  ],
});

export const InputUI = UIProvider.succeed<Input>("AWS.MediaLive.Input", {
  displayName: "MediaLive Input",
  icon: "camera",
  color: "#ED7100",
  category: "media",
  summary: (ctx) => ctx.attrs?.inputName ?? ctx.attrs?.inputId,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.inputArn);
    return ctx.attrs?.inputId === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/medialive/home?region=${region}#/inputs/${ctx.attrs.inputId}`;
  },
  facts: (ctx) => [
    { label: "input", value: ctx.attrs?.inputName, copy: true },
    { label: "id", value: ctx.attrs?.inputId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.inputArn, mono: true, copy: true },
    { label: "state", value: ctx.attrs?.state },
    { label: "type", value: ctx.attrs?.type },
    { label: "class", value: ctx.attrs?.inputClass },
    {
      label: "security groups",
      value: ctx.attrs?.securityGroups?.length,
    },
  ],
});

export const InputSecurityGroupUI = UIProvider.succeed<InputSecurityGroup>(
  "AWS.MediaLive.InputSecurityGroup",
  {
    displayName: "MediaLive Input Security Group",
    icon: "shield",
    color: "#ED7100",
    category: "security",
    summary: (ctx) => ctx.attrs?.inputSecurityGroupId,
    facts: (ctx) => [
      {
        label: "group",
        value: ctx.attrs?.inputSecurityGroupId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.inputSecurityGroupArn,
        mono: true,
        copy: true,
      },
      { label: "state", value: ctx.attrs?.state },
      {
        label: "whitelist",
        value: ctx.attrs?.whitelistRules?.length
          ? ctx.attrs.whitelistRules.join(", ")
          : undefined,
        mono: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(ChannelUI, InputUI, InputSecurityGroupUI);
