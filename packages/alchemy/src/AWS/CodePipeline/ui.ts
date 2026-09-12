import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Pipeline } from "./Pipeline.ts";

/**
 * Dashboard UI providers for AWS CodePipeline resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const PipelineUI = UIProvider.succeed<Pipeline>(
  "AWS.CodePipeline.Pipeline",
  {
    displayName: "CodePipeline Pipeline",
    icon: "workflow",
    color: "#E7157B",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.pipelineName,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.pipelineArn);
      return ctx.attrs?.pipelineName === undefined || region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/codesuite/codepipeline/pipelines/${ctx.attrs.pipelineName}/view?region=${region}`;
    },
    facts: (ctx) => [
      { label: "pipeline", value: ctx.attrs?.pipelineName, copy: true },
      { label: "arn", value: ctx.attrs?.pipelineArn, mono: true, copy: true },
      { label: "version", value: ctx.attrs?.pipelineVersion },
      { label: "role", value: ctx.props?.roleArn, mono: true },
      { label: "stages", value: ctx.props?.stages?.length },
      { label: "type", value: ctx.props?.pipelineType },
    ],
  },
);

export const ui = () => Layer.mergeAll(PipelineUI);
