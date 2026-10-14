import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Association } from "./Association.ts";
import type { CustomAction } from "./CustomAction.ts";
import type { MicrosoftTeamsChannelConfiguration } from "./MicrosoftTeamsChannelConfiguration.ts";
import type { SlackChannelConfiguration } from "./SlackChannelConfiguration.ts";

/**
 * Dashboard UI providers for AWS Chatbot resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Management & Governance (Chatbot) brand pink. */
const COLOR = "#E7157B";

export const SlackChannelConfigurationUI =
  UIProvider.succeed<SlackChannelConfiguration>(
    "AWS.Chatbot.SlackChannelConfiguration",
    {
      displayName: "Chatbot Slack Channel Configuration",
      icon: "message-square",
      color: COLOR,
      category: "config",
      summary: (ctx) => ctx.attrs?.configurationName,
      facts: (ctx) => [
        { label: "name", value: ctx.attrs?.configurationName, copy: true },
        {
          label: "arn",
          value: ctx.attrs?.chatConfigurationArn,
          mono: true,
          copy: true,
        },
        { label: "slack team", value: ctx.attrs?.slackTeamName },
        { label: "team id", value: ctx.attrs?.slackTeamId, mono: true },
        { label: "channel id", value: ctx.attrs?.slackChannelId, mono: true },
        { label: "state", value: ctx.attrs?.state },
      ],
    },
  );

export const MicrosoftTeamsChannelConfigurationUI =
  UIProvider.succeed<MicrosoftTeamsChannelConfiguration>(
    "AWS.Chatbot.MicrosoftTeamsChannelConfiguration",
    {
      displayName: "Chatbot Microsoft Teams Channel Configuration",
      icon: "message-square",
      color: COLOR,
      category: "config",
      summary: (ctx) => ctx.attrs?.configurationName,
      facts: (ctx) => [
        { label: "name", value: ctx.attrs?.configurationName, copy: true },
        {
          label: "arn",
          value: ctx.attrs?.chatConfigurationArn,
          mono: true,
          copy: true,
        },
        { label: "team id", value: ctx.attrs?.teamId, mono: true },
        { label: "tenant id", value: ctx.attrs?.tenantId, mono: true },
        { label: "channel id", value: ctx.attrs?.teamsChannelId, mono: true },
        { label: "state", value: ctx.attrs?.state },
      ],
    },
  );

export const CustomActionUI = UIProvider.succeed<CustomAction>(
  "AWS.Chatbot.CustomAction",
  {
    displayName: "Chatbot Custom Action",
    icon: "terminal",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.actionName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.actionName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.customActionArn,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const AssociationUI = UIProvider.succeed<Association>(
  "AWS.Chatbot.Association",
  {
    displayName: "Chatbot Association",
    icon: "link",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.resourceArn,
    facts: (ctx) => [
      {
        label: "chat configuration",
        value: ctx.attrs?.chatConfigurationArn,
        mono: true,
        copy: true,
      },
      {
        label: "resource",
        value: ctx.attrs?.resourceArn,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    SlackChannelConfigurationUI,
    MicrosoftTeamsChannelConfigurationUI,
    CustomActionUI,
    AssociationUI,
  );
