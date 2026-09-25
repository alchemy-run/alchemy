import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Broker } from "./Broker.ts";
import type { Configuration } from "./Configuration.ts";

/**
 * Dashboard UI providers for AWS MQ resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const BrokerUI = UIProvider.succeed<Broker>("AWS.MQ.Broker", {
  displayName: "MQ Broker",
  icon: "message-square",
  color: "#E7157B",
  category: "queue",
  summary: (ctx) => ctx.attrs?.brokerName,
  link: (ctx) => ctx.attrs?.consoleUrl,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.brokerArn);
    return ctx.attrs?.brokerId === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/amazon-mq/home?region=${region}#/brokers/${ctx.attrs.brokerId}`;
  },
  facts: (ctx) => [
    { label: "broker", value: ctx.attrs?.brokerName, copy: true },
    { label: "id", value: ctx.attrs?.brokerId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.brokerArn, mono: true, copy: true },
    { label: "state", value: ctx.attrs?.brokerState },
    { label: "engine", value: ctx.props?.engineType },
    { label: "instance type", value: ctx.props?.hostInstanceType },
    {
      label: "endpoints",
      value: ctx.attrs?.endpoints?.length
        ? ctx.attrs.endpoints.join(", ")
        : undefined,
      mono: true,
    },
  ],
});

export const ConfigurationUI = UIProvider.succeed<Configuration>(
  "AWS.MQ.Configuration",
  {
    displayName: "MQ Configuration",
    icon: "settings",
    color: "#E7157B",
    category: "queue",
    summary: (ctx) => ctx.attrs?.configurationName,
    facts: (ctx) => [
      {
        label: "configuration",
        value: ctx.attrs?.configurationName,
        copy: true,
      },
      {
        label: "id",
        value: ctx.attrs?.configurationId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.configurationArn,
        mono: true,
        copy: true,
      },
      { label: "engine", value: ctx.attrs?.engineType },
      { label: "engine version", value: ctx.attrs?.engineVersion },
      { label: "revision", value: ctx.attrs?.configurationRevision },
    ],
  },
);

export const ui = () => Layer.mergeAll(BrokerUI, ConfigurationUI);
