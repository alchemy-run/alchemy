import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Dashboard UI providers for AWS Grafana resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const WorkspaceUI = UIProvider.succeed<Workspace>(
  "AWS.Grafana.Workspace",
  {
    displayName: "Grafana Workspace",
    icon: "gauge",
    color: "#E7157B",
    category: "observability",
    summary: (ctx) => ctx.attrs?.workspaceId,
    link: (ctx) =>
      ctx.attrs?.endpoint === undefined
        ? undefined
        : ctx.attrs.endpoint.startsWith("http")
          ? ctx.attrs.endpoint
          : `https://${ctx.attrs.endpoint}`,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.workspaceArn);
      return ctx.attrs?.workspaceId === undefined || region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/grafana/home?region=${region}#/workspaces/${ctx.attrs.workspaceId}`;
    },
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.workspaceId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.workspaceArn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "version", value: ctx.attrs?.grafanaVersion },
      { label: "endpoint", value: ctx.attrs?.endpoint, mono: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(WorkspaceUI);
