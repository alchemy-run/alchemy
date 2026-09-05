import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AggregationAuthorization } from "./AggregationAuthorization.ts";
import type { ConfigRule } from "./ConfigRule.ts";
import type { ConfigurationRecorder } from "./ConfigurationRecorder.ts";
import type { DeliveryChannel } from "./DeliveryChannel.ts";
import type { RetentionConfiguration } from "./RetentionConfiguration.ts";

/**
 * Dashboard UI providers for AWS Config resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Management & Governance brand pink. */
const COLOR = "#E7157B";

export const AggregationAuthorizationUI =
  UIProvider.succeed<AggregationAuthorization>(
    "AWS.Config.AggregationAuthorization",
    {
      displayName: "Config Aggregation Authorization",
      icon: "share-2",
      color: COLOR,
      category: "config",
      summary: (ctx) =>
        ctx.attrs?.authorizedAccountId === undefined
          ? undefined
          : `${ctx.attrs.authorizedAccountId} (${ctx.attrs.authorizedAwsRegion ?? ""})`,
      facts: (ctx) => [
        {
          label: "arn",
          value: ctx.attrs?.aggregationAuthorizationArn,
          mono: true,
          copy: true,
        },
        {
          label: "account",
          value: ctx.attrs?.authorizedAccountId,
          mono: true,
          copy: true,
        },
        { label: "region", value: ctx.attrs?.authorizedAwsRegion },
      ],
    },
  );

export const ConfigRuleUI = UIProvider.succeed<ConfigRule>(
  "AWS.Config.ConfigRule",
  {
    displayName: "Config Rule",
    icon: "list-checks",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.configRuleName,
    facts: (ctx) => [
      { label: "rule", value: ctx.attrs?.configRuleName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.configRuleArn,
        mono: true,
        copy: true,
      },
      { label: "rule id", value: ctx.attrs?.configRuleId, mono: true },
      { label: "owner", value: ctx.props?.source?.owner },
      { label: "source", value: ctx.props?.source?.sourceIdentifier },
      { label: "description", value: ctx.props?.description },
    ],
  },
);

export const ConfigurationRecorderUI =
  UIProvider.succeed<ConfigurationRecorder>(
    "AWS.Config.ConfigurationRecorder",
    {
      displayName: "Configuration Recorder",
      icon: "scroll-text",
      color: COLOR,
      category: "config",
      summary: (ctx) => ctx.attrs?.recorderName,
      facts: (ctx) => [
        { label: "recorder", value: ctx.attrs?.recorderName, copy: true },
        { label: "arn", value: ctx.attrs?.recorderArn, mono: true, copy: true },
        { label: "role", value: ctx.props?.roleArn, mono: true },
        { label: "recording", value: ctx.props?.recording },
      ],
    },
  );

export const DeliveryChannelUI = UIProvider.succeed<DeliveryChannel>(
  "AWS.Config.DeliveryChannel",
  {
    displayName: "Config Delivery Channel",
    icon: "send",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.deliveryChannelName,
    facts: (ctx) => [
      { label: "channel", value: ctx.attrs?.deliveryChannelName, copy: true },
      {
        label: "bucket",
        value: ctx.attrs?.s3BucketName,
        mono: true,
        copy: true,
      },
      { label: "key prefix", value: ctx.props?.s3KeyPrefix, mono: true },
      { label: "sns topic", value: ctx.props?.snsTopicArn, mono: true },
    ],
  },
);

export const RetentionConfigurationUI =
  UIProvider.succeed<RetentionConfiguration>(
    "AWS.Config.RetentionConfiguration",
    {
      displayName: "Config Retention Configuration",
      icon: "clock",
      color: COLOR,
      category: "config",
      summary: (ctx) => ctx.attrs?.retentionConfigurationName,
      facts: (ctx) => [
        {
          label: "name",
          value: ctx.attrs?.retentionConfigurationName,
          copy: true,
        },
        {
          label: "retention (days)",
          value: ctx.attrs?.retentionPeriodInDays,
        },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(
    AggregationAuthorizationUI,
    ConfigRuleUI,
    ConfigurationRecorderUI,
    DeliveryChannelUI,
    RetentionConfigurationUI,
  );
