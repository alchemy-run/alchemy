import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Job } from "./Job.ts";
import type { JobTemplate } from "./JobTemplate.ts";
import type { Preset } from "./Preset.ts";
import type { Queue } from "./Queue.ts";

/**
 * Dashboard UI providers for AWS MediaConvert resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const JobUI = UIProvider.succeed<Job>("AWS.MediaConvert.Job", {
  displayName: "MediaConvert Job",
  icon: "play",
  color: "#ED7100",
  category: "media",
  summary: (ctx) => ctx.attrs?.jobId,
  facts: (ctx) => [
    { label: "id", value: ctx.attrs?.jobId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.jobArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "queue", value: ctx.attrs?.queue },
  ],
});

export const JobTemplateUI = UIProvider.succeed<JobTemplate>(
  "AWS.MediaConvert.JobTemplate",
  {
    displayName: "MediaConvert Job Template",
    icon: "file-text",
    color: "#ED7100",
    category: "media",
    summary: (ctx) => ctx.attrs?.jobTemplateName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.jobTemplateName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.jobTemplateArn,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.type },
      { label: "category", value: ctx.attrs?.category },
    ],
  },
);

export const PresetUI = UIProvider.succeed<Preset>("AWS.MediaConvert.Preset", {
  displayName: "MediaConvert Preset",
  icon: "pencil-ruler",
  color: "#ED7100",
  category: "media",
  summary: (ctx) => ctx.attrs?.presetName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.presetName, copy: true },
    { label: "arn", value: ctx.attrs?.presetArn, mono: true, copy: true },
    { label: "type", value: ctx.attrs?.type },
    { label: "category", value: ctx.attrs?.category },
  ],
});

export const QueueUI = UIProvider.succeed<Queue>("AWS.MediaConvert.Queue", {
  displayName: "MediaConvert Queue",
  icon: "list-ordered",
  color: "#ED7100",
  category: "media",
  summary: (ctx) => ctx.attrs?.queueName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.queueName, copy: true },
    { label: "arn", value: ctx.attrs?.queueArn, mono: true, copy: true },
    { label: "type", value: ctx.attrs?.type },
    { label: "status", value: ctx.attrs?.status },
    { label: "pricing plan", value: ctx.attrs?.pricingPlan },
  ],
});

export const ui = () => Layer.mergeAll(JobUI, JobTemplateUI, PresetUI, QueueUI);
