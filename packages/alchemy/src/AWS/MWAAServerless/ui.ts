import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Workflow } from "./Workflow.ts";

/**
 * Dashboard UI providers for AWS MWAAServerless resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const WorkflowUI = UIProvider.succeed<Workflow>(
  "AWS.MWAAServerless.Workflow",
  {
    displayName: "MWAA Serverless Workflow",
    icon: "workflow",
    color: "#E7157B",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.workflowArn,
        mono: true,
        copy: true,
      },
      { label: "version", value: ctx.attrs?.workflowVersion },
      { label: "status", value: ctx.attrs?.workflowStatus },
      { label: "role", value: ctx.attrs?.roleArn, mono: true },
      { label: "trigger mode", value: ctx.attrs?.triggerMode },
    ],
  },
);

export const ui = () => Layer.mergeAll(WorkflowUI);
