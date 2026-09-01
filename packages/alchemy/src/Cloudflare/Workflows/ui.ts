import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { WorkflowResource } from "./Workflow.ts";

/**
 * Dashboard UI providers for Cloudflare Workflows resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const WorkflowUI = UIProvider.succeed<WorkflowResource>(
  "Cloudflare.Workflow",
  {
    displayName: "Workflow",
    icon: "workflow",
    color: "#F6821F",
    category: "compute",
    summary: (ctx) => ctx.attrs?.workflowName,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined || ctx.attrs.workflowName === undefined
        ? undefined
        : `https://dash.cloudflare.com/${ctx.attrs.accountId}/workers/workflows/${ctx.attrs.workflowName}`,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.workflowName, copy: true },
      { label: "id", value: ctx.attrs?.workflowId, mono: true, copy: true },
      { label: "class", value: ctx.attrs?.className, mono: true },
      { label: "script", value: ctx.attrs?.scriptName, mono: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(WorkflowUI);
