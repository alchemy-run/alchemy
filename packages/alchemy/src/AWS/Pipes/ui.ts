import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Pipe } from "./Pipe.ts";

/**
 * Dashboard UI providers for AWS Pipes resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const PipeUI = UIProvider.succeed<Pipe>("AWS.Pipes.Pipe", {
  displayName: "EventBridge Pipe",
  icon: "route",
  color: "#E7157B",
  category: "eventing",
  summary: (ctx) => ctx.attrs?.pipeName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.pipeArn);
    return region === undefined || ctx.attrs?.pipeName === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/pipes/home?region=${region}#/pipes/${ctx.attrs.pipeName}`;
  },
  facts: (ctx) => [
    { label: "pipe", value: ctx.attrs?.pipeName, copy: true },
    { label: "arn", value: ctx.attrs?.pipeArn, mono: true, copy: true },
    { label: "state", value: ctx.attrs?.currentState },
    { label: "source", value: ctx.props?.source, mono: true },
    { label: "target", value: ctx.props?.target, mono: true },
    { label: "role", value: ctx.props?.roleArn, mono: true },
  ],
});

export const ui = () => Layer.mergeAll(PipeUI);
