import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Policy } from "./Policy.ts";
import type { Thing } from "./Thing.ts";
import type { ThingType } from "./ThingType.ts";
import type { TopicRule } from "./TopicRule.ts";

/**
 * Dashboard UI providers for AWS IoT resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const IOT_COLOR = "#8C4FFF";

const regionOf = (arn: string | undefined) => arn?.split(":")[3];

export const PolicyUI = UIProvider.succeed<Policy>("AWS.IoT.Policy", {
  displayName: "IoT Policy",
  icon: "key-round",
  color: IOT_COLOR,
  category: "security",
  summary: (ctx) => ctx.attrs?.policyName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.policyArn);
    return ctx.attrs?.policyName === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/iot/home?region=${region}#/policy/${encodeURIComponent(ctx.attrs.policyName)}`;
  },
  facts: (ctx) => [
    { label: "policy", value: ctx.attrs?.policyName, copy: true },
    { label: "arn", value: ctx.attrs?.policyArn, mono: true, copy: true },
  ],
});

export const ThingUI = UIProvider.succeed<Thing>("AWS.IoT.Thing", {
  displayName: "IoT Thing",
  icon: "cpu",
  color: IOT_COLOR,
  category: "network",
  summary: (ctx) => ctx.attrs?.thingName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.thingArn);
    return ctx.attrs?.thingName === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/iot/home?region=${region}#/thing/${encodeURIComponent(ctx.attrs.thingName)}`;
  },
  facts: (ctx) => [
    { label: "thing", value: ctx.attrs?.thingName, copy: true },
    { label: "arn", value: ctx.attrs?.thingArn, mono: true, copy: true },
    { label: "type", value: ctx.props?.thingTypeName },
  ],
});

export const ThingTypeUI = UIProvider.succeed<ThingType>("AWS.IoT.ThingType", {
  displayName: "IoT Thing Type",
  icon: "layers",
  color: IOT_COLOR,
  category: "network",
  summary: (ctx) => ctx.attrs?.thingTypeName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.thingTypeArn);
    return ctx.attrs?.thingTypeName === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/iot/home?region=${region}#/thingtype/${encodeURIComponent(ctx.attrs.thingTypeName)}`;
  },
  facts: (ctx) => [
    { label: "type", value: ctx.attrs?.thingTypeName, copy: true },
    { label: "arn", value: ctx.attrs?.thingTypeArn, mono: true, copy: true },
    {
      label: "searchable attributes",
      value: ctx.props?.searchableAttributes?.join(", "),
    },
  ],
});

export const TopicRuleUI = UIProvider.succeed<TopicRule>("AWS.IoT.TopicRule", {
  displayName: "IoT Topic Rule",
  icon: "route",
  color: IOT_COLOR,
  category: "eventing",
  summary: (ctx) => ctx.attrs?.ruleName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.ruleArn);
    return ctx.attrs?.ruleName === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/iot/home?region=${region}#/rule/${encodeURIComponent(ctx.attrs.ruleName)}`;
  },
  facts: (ctx) => [
    { label: "rule", value: ctx.attrs?.ruleName, copy: true },
    { label: "arn", value: ctx.attrs?.ruleArn, mono: true, copy: true },
    { label: "sql", value: ctx.props?.sql, mono: true },
    { label: "disabled", value: ctx.props?.ruleDisabled },
  ],
});

export const ui = () =>
  Layer.mergeAll(PolicyUI, ThingUI, ThingTypeUI, TopicRuleUI);
