import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ComputeEnvironment } from "./ComputeEnvironment.ts";
import type { JobQueue } from "./JobQueue.ts";

/**
 * Dashboard UI providers for AWS Batch resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const ComputeEnvironmentUI = UIProvider.succeed<ComputeEnvironment>(
  "AWS.Batch.ComputeEnvironment",
  {
    displayName: "Batch Compute Environment",
    icon: "cpu",
    color: "#ED7100",
    category: "compute",
    summary: (ctx) => ctx.attrs?.computeEnvironmentName,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.computeEnvironmentArn);
      return region === undefined ||
        ctx.attrs?.computeEnvironmentName === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/batch/home?region=${region}#compute-environments/detail/${ctx.attrs.computeEnvironmentName}`;
    },
    facts: (ctx) => [
      {
        label: "environment",
        value: ctx.attrs?.computeEnvironmentName,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.computeEnvironmentArn,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.type },
      { label: "management", value: ctx.attrs?.managementType },
      { label: "state", value: ctx.attrs?.state },
      { label: "status", value: ctx.attrs?.status },
      { label: "max vcpus", value: ctx.attrs?.maxvCpus },
    ],
  },
);

export const JobQueueUI = UIProvider.succeed<JobQueue>("AWS.Batch.JobQueue", {
  displayName: "Batch Job Queue",
  icon: "list-ordered",
  color: "#ED7100",
  category: "queue",
  summary: (ctx) => ctx.attrs?.jobQueueName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.jobQueueArn);
    return region === undefined || ctx.attrs?.jobQueueName === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/batch/home?region=${region}#queues/detail/${ctx.attrs.jobQueueName}`;
  },
  facts: (ctx) => [
    { label: "queue", value: ctx.attrs?.jobQueueName, copy: true },
    { label: "arn", value: ctx.attrs?.jobQueueArn, mono: true, copy: true },
    { label: "state", value: ctx.attrs?.state },
    { label: "status", value: ctx.attrs?.status },
    { label: "priority", value: ctx.attrs?.priority },
    {
      label: "compute environments",
      value: ctx.attrs?.computeEnvironments?.length
        ? ctx.attrs.computeEnvironments.join(", ")
        : undefined,
      mono: true,
    },
  ],
});

export const ui = () => Layer.mergeAll(ComputeEnvironmentUI, JobQueueUI);
