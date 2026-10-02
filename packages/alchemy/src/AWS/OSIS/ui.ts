import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Pipeline } from "./Pipeline.ts";
import type { PipelineEndpoint } from "./PipelineEndpoint.ts";
import type { ResourcePolicy } from "./ResourcePolicy.ts";

/**
 * Dashboard UI providers for AWS OSIS resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Analytics (OpenSearch Ingestion) brand purple. */
const COLOR = "#8C4FFF";

export const PipelineUI = UIProvider.succeed<Pipeline>("AWS.OSIS.Pipeline", {
  displayName: "OpenSearch Ingestion Pipeline",
  icon: "workflow",
  color: COLOR,
  category: "eventing",
  summary: (ctx) => ctx.attrs?.pipelineName,
  facts: (ctx) => [
    { label: "pipeline", value: ctx.attrs?.pipelineName, copy: true },
    { label: "arn", value: ctx.attrs?.pipelineArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "min units", value: ctx.attrs?.minUnits },
    { label: "max units", value: ctx.attrs?.maxUnits },
    {
      label: "ingest urls",
      value: ctx.attrs?.ingestEndpointUrls?.length
        ? ctx.attrs.ingestEndpointUrls.join(", ")
        : undefined,
      mono: true,
    },
  ],
});

export const PipelineEndpointUI = UIProvider.succeed<PipelineEndpoint>(
  "AWS.OSIS.PipelineEndpoint",
  {
    displayName: "OpenSearch Ingestion Pipeline Endpoint",
    icon: "network",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.endpointId,
    facts: (ctx) => [
      {
        label: "endpoint",
        value: ctx.attrs?.endpointId,
        mono: true,
        copy: true,
      },
      {
        label: "pipeline",
        value: ctx.attrs?.pipelineArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      {
        label: "ingest url",
        value: ctx.attrs?.ingestEndpointUrl,
        mono: true,
      },
    ],
  },
);

export const ResourcePolicyUI = UIProvider.succeed<ResourcePolicy>(
  "AWS.OSIS.ResourcePolicy",
  {
    displayName: "OpenSearch Ingestion Resource Policy",
    icon: "lock",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.resourceArn,
    facts: (ctx) => [
      {
        label: "resource",
        value: ctx.attrs?.resourceArn,
        mono: true,
        copy: true,
      },
      { label: "policy", value: ctx.attrs?.policy, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(PipelineUI, PipelineEndpointUI, ResourcePolicyUI);
