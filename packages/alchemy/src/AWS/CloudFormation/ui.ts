import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Stack } from "./Stack.ts";

/**
 * Dashboard UI providers for AWS CloudFormation resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const StackUI = UIProvider.succeed<Stack>("AWS.CloudFormation.Stack", {
  displayName: "CloudFormation Stack",
  icon: "layers",
  color: "#E7157B",
  category: "config",
  summary: (ctx) => ctx.attrs?.stackName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.stackId);
    return region === undefined || ctx.attrs?.stackId === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/stackinfo?stackId=${encodeURIComponent(ctx.attrs.stackId)}`;
  },
  facts: (ctx) => [
    { label: "stack", value: ctx.attrs?.stackName, copy: true },
    { label: "stack id", value: ctx.attrs?.stackId, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.stackStatus },
    {
      label: "outputs",
      value: ctx.attrs?.outputs
        ? Object.keys(ctx.attrs.outputs).length
        : undefined,
    },
  ],
});

export const ui = () => Layer.mergeAll(StackUI);
